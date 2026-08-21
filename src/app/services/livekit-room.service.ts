import {inject, Injectable, InjectionToken, signal} from '@angular/core';
import type {RemoteParticipant, RoomEventCallbacks} from 'livekit-client';
import {trace} from '../core/log';
import {
    ConnectionState,
    RemoteTrackPublication,
    Room,
    RoomEvent,
    RoomOptions,
    Track,
    VideoQuality,
} from 'livekit-client';

/** How the service obtains a room. Injected so specs can drive one without a server. */
export type LiveKitRoomFactory = (options: RoomOptions) => Room;

/** Builds a real `Room`. Replaced in tests; never replaced in the app. */
export const LIVEKIT_ROOM_FACTORY = new InjectionToken<LiveKitRoomFactory>('livekit.room.factory', {
    providedIn: 'root',
    factory: () => (options: RoomOptions) => new Room(options),
});

/**
 * Whether the audio in this room is somebody else's problem.
 *
 * <p>True on desktop: the Rust room holds every microphone and every `screen-audio-*` track, feeds
 * them to the mixer, and is where AEC and per-source volume live. A webview that also subscribed to
 * audio would play the room twice, and the second copy is not muteable from any control the user
 * can see. False in the browser build, where there is no Rust and this room is the only one.</p>
 *
 * <p><b>Injected rather than sniffed.</b> The service must not ask `isTauri()` - the host and the
 * ownership of audio are two different facts that happen to correlate today, and a webview-publishing
 * target on desktop would break the correlation. The default is the restrictive one: a wrong `true`
 * costs a browser its sound, which is loud and gets fixed; a wrong `false` costs desktop double
 * playout, which sounds like an echo and gets blamed on the SFU.</p>
 */
export const LIVEKIT_AUDIO_IS_OURS = new InjectionToken<boolean>('livekit.audio-is-ours', {
    providedIn: 'root',
    factory: () => true,
});

/**
 * The server's ranking vocabulary: `a` is the top rung, `c` the bottom.
 *
 * <p><b>Not a rid.</b> What we publish is named `f`/`h`/`q`, the server never sees a rid, and the two
 * vocabularies run in opposite directions - so a lookup that accepted either would cap a viewer at a
 * rung nobody chose. The letters survived the migration off Cloudflare only because renaming them to
 * high/medium/low would cost every client at once (§6.1); the asciibetical reasoning that used to
 * justify them is dead and is deliberately not repeated here.</p>
 */
const QUALITY_BY_LAYER: Readonly<Record<string, VideoQuality>> = {
    a: VideoQuality.HIGH,
    b: VideoQuality.MEDIUM,
    c: VideoQuality.LOW,
};

/** Where to reach a room, as `POST .../voice/connection` answers it. */
export interface LiveKitConnection {
    url: string;
    token: string;
}

/** A track this room holds, in the vocabulary the rest of the app speaks. */
export interface RemoteMediaTrack {
    trackSid: string;
    /** The participant string the SFU used. Kept because a share is announced against it. */
    identity: string;
    /** {@link identity} with any `#tag` taken off - what every roster and tile is keyed by. */
    userId: string;
    kind: Track.Kind;
    source: Track.Source;
    publication: RemoteTrackPublication;
}

/**
 * The one place this client touches `livekit-client`.
 *
 * <p>Everything above it - roster state, gating, backfill, the heartbeat - keeps speaking in user
 * ids and track sids, and never sees a `Room`, a `RemoteTrackPublication` or a `VideoQuality`.</p>
 */
@Injectable({providedIn: 'root'})
export class LiveKitRoomService {
    private readonly newRoom = inject(LIVEKIT_ROOM_FACTORY);
    private readonly audioIsOurs = inject(LIVEKIT_AUDIO_IS_OURS);

    private room: Room | null = null;

    /**
     * Bumped whenever the set of publications this room knows about changes.
     *
     * <p>Distinct from {@link remoteTracks}, which is what the room *holds* - this is what it has
     * been *told about*, subscribed or not. Subscribing needs both halves: the roster names the
     * track a viewer wants, and only the room knows the sid to ask for it by. Whichever half lands
     * second has to re-run the reconcile, and this is the signal that says the room's half did.</p>
     *
     * <p>A counter rather than the set: the only question a reader has is "has anything changed
     * since I last reconciled", and it re-derives what it needs from {@link publicationsOf}.</p>
     */
    readonly publications = signal(0);

    /**
     * How many audio subscriptions this room turned down.
     *
     * <p>Non-zero is not a fault on desktop - it is the guard doing its job against a plan that does
     * not know which of our two connections it is talking to. It is a fault in the browser build,
     * where it means {@link LIVEKIT_AUDIO_IS_OURS} was left at its desktop default and the room will
     * be silent, so it is counted rather than only logged.</p>
     */
    readonly refusedAudioSubscriptions = signal(0);

    /**
     * How many `layer` spellings this client did not recognise.
     *
     * <p>The fallback is silent by design - the viewer keeps whatever the server was already sending -
     * so without a counter a vocabulary drift looks exactly like a room that never caps anything.</p>
     */
    readonly unrecognisedLayers = signal(0);

    /** Where the SDK thinks the connection is. `Disconnected` until a connect lands, and again after. */
    readonly state = signal<ConnectionState>(ConnectionState.Disconnected);

    /** Every track this room currently holds, by sid, already resolved to the user behind it. */
    readonly remoteTracks = signal<ReadonlyMap<string, RemoteMediaTrack>>(new Map());

    /** Kept so teardown can detach exactly what was attached, on the room it was attached to. */
    private listeners: (() => void)[] = [];

    /**
     * Joins a room, subscribed to nothing.
     *
     * <p><b>`autoSubscribe: false` is not a tuning knob.</b> §6.6 puts the server's subscription plan
     * in charge of what we pull, and a client that has already subscribed to everything by the time
     * the first plan arrives has nothing left for the plan to decide. On desktop it is also what keeps
     * the webview off the audio the Rust room is already playing.</p>
     */
    async connect(connection: LiveKitConnection): Promise<void> {
        // **`adaptiveStream` must stay off while this app renders with `srcObject`**, because with
        // it on every remote tile is pinned to the *lowest* simulcast rung for the whole call.
        //
        // It ties the layer served to how large the tile is on screen, and the SDK measures that
        // from elements registered through `RemoteTrack.attach(el)` - the only thing that populates
        // `elementInfos`. This client never calls it: tiles bind a `MediaStream` straight to
        // `video.srcObject` (see `StreamSrcDirective`). So the element list is permanently empty and
        // the SDK asks for the smallest layer there is.
        //
        // Measured against `livekit-server` 1.13.5 with `livekit-client` 2.21.0, same publisher,
        // same room, one flag changed - `setSubscribed` and `srcObject` exactly as below:
        //
        //     adaptiveStream: true    ~24 kB / 2 s   videoWidth 320
        //     adaptiveStream: false  ~400 kB / 2 s   videoWidth 1280
        //
        // Note what it is *not*: the track keeps flowing either way. An unattached track is not
        // disabled, it is starved, so this shows up as a soft, smeared tile rather than a black one
        // and no counter anywhere reads as broken.
        //
        // Turning it back on means moving the render path to `track.attach()` first. The economy is
        // real, but it is a contract with the rendering layer and this client does not hold up its
        // end.
        //
        // `dynacast` stays: publisher-side, driven by what the server sees subscribers ask for, so
        // it needs nothing from our DOM.
        const room = this.newRoom({adaptiveStream: false, dynacast: true});
        this.room = room;
        this.listen(room);
        await room.connect(connection.url, connection.token, {autoSubscribe: false});
    }

    /**
     * Leaves the room and forgets it.
     *
     * <p>The listeners come off before anything else and by the reference they went on with. A handler
     * left on a discarded room keeps that room, its participants and their media reachable, and keeps
     * writing into the same signals the next connection writes into - so a stale room and a live one
     * would fight over `remoteTracks` with only one of them attached to anything the user can see.</p>
     */
    async disconnect(): Promise<void> {
        const room = this.room;
        this.detach();
        this.room = null;
        this.remoteTracks.set(new Map());
        this.state.set(ConnectionState.Disconnected);
        await room?.disconnect();
    }

    private listen(room: Room): void {
        this.on(room, RoomEvent.TrackSubscribed, (_track, publication, participant) =>
            this.remember(publication, participant),
        );
        this.on(room, RoomEvent.TrackUnsubscribed, (_track, publication) =>
            this.forget(publication.trackSid),
        );
        this.on(room, RoomEvent.ConnectionStateChanged, state => this.state.set(state));

        // **What the room has learned about, as opposed to what it holds.** Subscribing is a
        // two-source job: the roster says which track a viewer wants, and only the room knows the
        // sid to ask for it by. Whichever arrives second has to re-run the diff, and until this
        // existed only one of the two ever did - so a roster announcement that beat the SFU's
        // signalling resolved to no sid, was skipped as "ordinary, try next pass", and no next pass
        // was ever scheduled. The tile stayed black for the rest of the session.
        //
        // `TrackPublished` alone is not enough: publications a participant already held when they
        // joined arrive with the participant, never as an event of their own.
        const changed = () => this.publications.update(n => n + 1);
        this.on(room, RoomEvent.TrackPublished, changed);
        this.on(room, RoomEvent.TrackUnpublished, changed);
        this.on(room, RoomEvent.ParticipantConnected, changed);
    }

    /** Registers a handler and records how to take it off again. */
    private on<E extends keyof RoomEventCallbacks>(
        room: Room,
        event: E,
        handler: RoomEventCallbacks[E],
    ): void {
        room.on(event, handler);
        this.listeners.push(() => room.off(event, handler));
    }

    private detach(): void {
        for (const remove of this.listeners) remove();
        this.listeners = [];
    }

    private remember(publication: RemoteTrackPublication, participant: RemoteParticipant): void {
        const next = new Map(this.remoteTracks());
        next.set(publication.trackSid, {
            trackSid: publication.trackSid,
            identity: participant.identity,
            userId: this.userOf(participant.identity),
            kind: publication.kind,
            source: publication.source,
            publication,
        });
        this.remoteTracks.set(next);

        // The moment a subscription becomes media, which is the one event that separates "the SFU
        // took our subscribe" from "the SFU is sending". Asking for a track and receiving one are
        // different things, and only this says the second happened.
        trace(
            `[livekit] track arrived: ${publication.trackName} (${publication.kind}/${publication.source})` +
                ` from ${participant.identity}, mediaStreamTrack=${!!publication.track?.mediaStreamTrack}`,
        );
    }

    private forget(trackSid: string): void {
        if (!this.remoteTracks().has(trackSid)) return;
        // The other end of `track arrived`. A picture that appears and then goes is either this or a
        // rebuild that found nothing, and the two have completely different causes.
        trace(
            `[livekit] track gone: ${this.remoteTracks().get(trackSid)?.publication.trackName} (${trackSid})`,
        );
        const next = new Map(this.remoteTracks());
        next.delete(trackSid);
        this.remoteTracks.set(next);
    }

    /**
     * Pulls a track, or stops pulling it.
     *
     * <p>Answers whether the room now holds what was asked for. `false` means either that the sid is
     * unknown here - ordinary, since a plan can name a track whose `TrackPublished` has not arrived -
     * or that the subscription was refused under {@link LIVEKIT_AUDIO_IS_OURS}. Both are for the
     * caller to carry into its next diff rather than to raise.</p>
     *
     * <p>Only *subscribing* to audio is refused. Unsubscribing is allowed on any kind: it can never
     * cause double playout, and refusing it would strand a subscription that a reconnect restored
     * more broadly than we asked for.</p>
     */
    setSubscribed(trackSid: string, subscribed: boolean): boolean {
        const publication = this.publicationOf(trackSid);
        if (!publication) return false;

        if (subscribed && this.audioIsOurs && publication.kind === Track.Kind.Audio) {
            this.refusedAudioSubscriptions.update(count => count + 1);
            console.warn(
                `[livekit] refused an audio subscription (${publication.source}, ${trackSid}): the Rust room already plays it`,
            );
            return false;
        }

        publication.setSubscribed(subscribed);
        return true;
    }

    /**
     * Caps a subscription at the rung the server's plan named.
     *
     * <p>Answers whether a cap was applied. `false` on an absent `layer` - the ordinary uncapped case,
     * and what every audio entry carries - and on a spelling this client does not know, which is the
     * documented fallback: <b>leave the server's choice alone rather than guess</b>. Guessing would
     * pin a viewer to a rung nobody chose, and adaptive stream would then never move them off it.</p>
     */
    setLayer(trackSid: string, layer: string | null | undefined): boolean {
        if (layer === null || layer === undefined) return false;

        const quality = QUALITY_BY_LAYER[layer];
        if (quality === undefined) {
            this.unrecognisedLayers.update(count => count + 1);
            console.warn(
                `[livekit] leaving the server's choice for ${trackSid}: unrecognised layer "${layer}"`,
            );
            return false;
        }

        const publication = this.publicationOf(trackSid);
        if (!publication) return false;

        publication.setVideoQuality(quality);
        return true;
    }

    /**
     * The user behind a participant identity.
     *
     * <p>Identity is the bare user id on a primary connection and `{userId}#{tag}` on a secondary, so
     * a remote participant maps to a user <b>without consulting the snapshot</b> - which is what lets a
     * track that arrives before its roster row still be attributed to somebody.</p>
     *
     * <p>Splits on the <b>first</b> `#`. A later one can only be inside a tag the server should have
     * stripped; splitting on the last would hand back a user id with half a tag glued to it, and
     * every lookup against it would miss. Twin of `media/livekit/identity.rs::user_of`.</p>
     */
    userOf(identity: string): string {
        const at = identity.indexOf('#');
        return at === -1 ? identity : identity.slice(0, at);
    }

    /** The publication behind a sid, over every remote participant. */
    /**
     * Every track this user publishes, **subscribed or not**.
     *
     * <p>This is the lookup that turns a roster row into a track sid, and it has to read the room
     * rather than {@link remoteTracks}: that signal is written from `TrackSubscribed`, so with
     * `autoSubscribe: false` it is empty until something has already been pulled. Resolving a sid
     * from it would be circular - nothing could ever be subscribed to in the first place.</p>
     *
     * <p>`room.remoteParticipants` carries the publications the server announced whether or not we
     * took them, which is exactly the set a roster needs to choose from.</p>
     */
    publicationsOf(userId: string): readonly {trackSid: string; trackName: string}[] {
        const found: {trackSid: string; trackName: string}[] = [];
        for (const participant of this.room?.remoteParticipants.values() ?? []) {
            if (this.userOf(participant.identity) !== userId) continue;
            for (const publication of participant.trackPublications.values()) {
                found.push({
                    trackSid: publication.trackSid,
                    trackName: publication.trackName,
                });
            }
        }
        return found;
    }

    /**
     * Publish a local track under the name the roster and every peer resolve it by.
     *
     * <p>The name is the contract - `audio`, `camera`, `screen-{shareId}`,
     * `screen-audio-{shareId}` - so it is passed explicitly rather than left to the SDK, which would
     * name it after the device. The `source` is derived from that same name: it is what a client
     * grouping by source reads before it has parsed anything, and a share announced as a microphone
     * reads as a second person talking.</p>
     *
     * <p>Note the prefix test order. `screen-audio-` also satisfies `startsWith('screen-')`, so it
     * must be tested first - backwards, a share's audio is published as the *video* of a share whose
     * id begins with `audio-`, which no viewer will ever ask for.</p>
     */
    async publishTrack(track: MediaStreamTrack, trackName: string): Promise<void> {
        const room = this.room;
        if (!room) throw new Error('cannot publish before the room is connected');

        const source = trackName.startsWith('screen-audio-')
            ? Track.Source.ScreenShareAudio
            : trackName.startsWith('screen-')
              ? Track.Source.ScreenShare
              : track.kind === 'audio'
                ? Track.Source.Microphone
                : Track.Source.Camera;

        await room.localParticipant.publishTrack(track, {name: trackName, source});
    }

    /**
     * Stop publishing the named track.
     *
     * <p>Silent when nothing of that name is published. Teardown runs on failure paths as well as
     * success, so it is routinely asked to remove things that were never added, and making that an
     * error turns one failed publish into two failures.</p>
     */
    async unpublishTrack(trackName: string): Promise<void> {
        const room = this.room;
        if (!room) return;

        for (const publication of room.localParticipant.trackPublications.values()) {
            if (publication.trackName !== trackName) continue;
            const track = publication.track;
            if (track) await room.localParticipant.unpublishTrack(track.mediaStreamTrack);
            return;
        }
    }

    private publicationOf(trackSid: string): RemoteTrackPublication | undefined {
        for (const participant of this.room?.remoteParticipants.values() ?? []) {
            const publication = participant.trackPublications.get(trackSid);
            if (publication) return publication;
        }
        return undefined;
    }
}
