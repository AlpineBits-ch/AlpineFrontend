import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ConnectionState} from 'livekit-client';
import {firstValueFrom, Subject} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {ApiConfigService} from "./api-config.service";
import {DeviceIdentityService} from "./device-identity.service";
import {OAuthService} from 'angular-oauth2-oidc';
import {
    bitrateFor,
    clampPreset,
    DEFAULT_STREAM_PRESET,
    StreamPreset,
} from '../models/stream-preset';
import {VoiceLimitsService} from './voice-limits.service';
import {solveGeometry} from '../models/capture-geometry';
import {publishOptions} from './screen-publish';
import {describeTrack, MICROPHONE_TRACK, screenAudioTrackName, screenTrackName} from '../models/voice-room';
import {VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {VoiceEngineService, VoiceSession, VoiceTarget} from './voice-engine.service';
import {ScreenPickerChoice} from './screen-picker.service';
import {LiveKitRoomService} from './livekit-room.service';
import {inboundScreenFpsByUser, InboundTrackOwner} from '../shared/call/inbound-fps';
import {inboundStatsFor, kbpsBetween} from '../shared/call/stream-stats';
import type {StreamStatsSample, StreamStatsSnapshot} from '../shared/call/stream-stats';

export interface VoiceSpeakingChange {
    userId: string;
    isSpeaking: boolean;
}

/**
 * The tag this connection takes, so its identity is `{userId}#view`.
 *
 * <p>One tag per connection per user: two connections sharing a tag share an identity and the second
 * evicts the first, so this string must never be reused for a second webview room. The Rust room -
 * the microphone, the mixer and every `screen-audio-*` track - connects as the bare user id beside
 * it, which is what keeps the two from colliding.</p>
 */
const VIEW_TAG = 'view';

/**
 * The name a camera is published under.
 *
 * <p>Not `audio` and not prefixed `screen-`, which is the whole of what the name has to satisfy:
 * {@link describeTrack} mirrors the server's own `TrackNaming.Describe` and reads anything else as a
 * camera. Declared once so the publish, the unpublish and the close all name the same track - they
 * used to read a name back off the negotiate reply, and there is no negotiate reply any more.</p>
 */
export const CAMERA_TRACK = 'camera';

/**
 * Backoff between attempts to pull a remote audio track into the Rust mixer, in milliseconds.
 *
 * <p>The Cloudflare race this was sized against is gone - there is no `tracks/new` to be early for -
 * but the shape of the failure survived the move: the roster announces a publisher as soon as the
 * room records the publication, which can reach us before the SFU's own `TrackPublished` reaches the
 * Rust room, and a subscribe for a track that room has not seen yet is refused. An announcement is
 * never repeated, so a single failed attempt is a participant who stays silent for the rest of the
 * session.</p>
 *
 * <p>Exponential and starting at a second, per the guidance from incident VNT-GE21R3P7: the log
 * there showed the same subscribe reattempted every 5-6 seconds with no backoff at all. What that
 * incident's *stale* and *spent session* branches used to add here is gone with the SDP relay - see
 * design §8, there is no subscribe request for the backend to refuse and no minted session id to go
 * stale - so what remains is genuine transport failure and nothing else.</p>
 *
 * <p>Exported so the schedule is asserted rather than described.</p>
 */
export const SUBSCRIBE_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * How this client's `RTCPeerConnectionState` reads off the room's connection state.
 *
 * <p>`Disconnected` is `'new'` rather than `'failed'`: it is what a room reads before a connect has
 * landed as well as after one has ended, and the status bar's "connecting" is the honest answer for
 * the first. Every flavour of reconnect is `'connecting'`, because the difference between resuming
 * the signal socket and rebuilding the whole room is not one a status bar can act on.</p>
 */
const PC_STATE_BY_CONNECTION: Readonly<Record<ConnectionState, RTCPeerConnectionState>> = {
    [ConnectionState.Disconnected]: 'new',
    [ConnectionState.Connecting]: 'connecting',
    [ConnectionState.Connected]: 'connected',
    [ConnectionState.Reconnecting]: 'connecting',
    [ConnectionState.SignalReconnecting]: 'connecting',
};

/**
 * The half of a room wrapper this service needs and {@link LiveKitRoomService} does not carry yet.
 *
 * <p>That service wraps connect, subscribe-by-sid and layer selection. Two things are missing from
 * it here: <b>the publications it has not subscribed to</b> - `remoteTracks()` is written from
 * `TrackSubscribed`, so with `autoSubscribe: false` it is empty until we have already pulled
 * something, and a roster row naming `(userId, trackName)` has no way to find the sid it must ask
 * for - and <b>publishing a local track</b>, which the camera needs.</p>
 *
 * <p>Declared as the seam rather than reached around the wrapper's `private room`. Everything below
 * is written against it, so the day those two methods land on `LiveKitRoomService` this file needs no
 * edit; until then {@link VoiceRTCService.roomMedia} finds them absent and says so once, loudly,
 * rather than leaving a camera capturing behind a publication that never happened.</p>
 */
export interface RoomPublishing {
    /** Every publication this user holds, subscribed or not, so a roster row can find its sid. */
    publicationsOf(userId: string): readonly {trackSid: string; trackName: string}[];
    /** Publishes a local track under the name the roster and the peers agree on. */
    publishTrack(track: MediaStreamTrack, trackName: string): Promise<void>;
    unpublishTrack(trackName: string): Promise<void>;
}

/**
 * What a video publish is about to send, read off the track the device actually opened.
 *
 * <p>The settings rather than the constraint, because a camera negotiates its own: asking for 720p
 * and being handed 1080p is ordinary, and stating the request would have the server clamp against a
 * resolution nothing is sending. The same holds for a capture the host resized on us.</p>
 *
 * <p>Undefined when either half is unknown, which omits the field entirely. The server then behaves
 * as it did before the field existed - a clamp it cannot compute is better than one computed from a
 * number this client made up.</p>
 */
export function trackIntent(track: MediaStreamTrack): VideoPublishIntentDto | undefined {
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
    const height = settings?.height;
    const framerate = settings?.frameRate;
    if (!height || height <= 0 || !framerate || framerate <= 0) return undefined;
    return {height, framerate: Math.round(framerate)};
}

/**
 * The detailed inbound snapshot for one inspected user's screen stream.
 *
 * <p>Keyed by user, not share, because the owner map carries no per-share id and the guild
 * `CallScreenShare[]` is built one row per participant - the identical reasoning as
 * `inboundScreenFpsByUser`, see `inbound-fps.ts`.</p>
 *
 * <p>Exported and free-standing so it can be tested without a room: the service's own poll is a
 * two-line wrapper around it.</p>
 */
export function detailedStatsFor(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
    userId: string | null,
): StreamStatsSample | null {
    for (const [mid, owner] of tracks) {
        if (owner.kind === 'screen' && owner.userId === userId) return inboundStatsFor(report, mid);
    }
    return null;
}

/**
 * The mid a per-track statistics report files its inbound stream under.
 *
 * <p>The SDK answers `getRTCStatsReport()` per track rather than per connection, so the mid is no
 * longer known before the report is read - it used to come back on the negotiate reply. Read out of
 * the report instead, once, so `inbound-fps.ts` and `stream-stats.ts` keep keying on a mid exactly
 * as they do on the DM surface rather than growing a second lookup for this host.</p>
 */
export function midOfReport(report: {forEach(callback: (stat: RTCStats) => void): void}): string | null {
    let mid: string | null = null;
    report.forEach(stat => {
        if (mid !== null) return;
        const s = stat as unknown as Record<string, unknown>;
        if (s['type'] === 'inbound-rtp' && s['kind'] === 'video' && typeof s['mid'] === 'string') {
            mid = s['mid'] as string;
        }
    });
    return mid;
}

export interface StaleSubscription {
    /** Whose track we asked for, when it is known. */
    userId?: string;
}

@Injectable({providedIn: 'root'})
export class VoiceRTCService {
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private readonly livekit = inject(LiveKitRoomService);

    /** True once the Rust engine is capturing and publishing. See {@link rtcState}. */
    private readonly engineUp = signal(false);

    /**
     * What the voice UI shows as the connection state.
     *
     * The room this service holds subscribes video and publishes a camera, so while you are alone in
     * a channel with no cameras on there is nothing on it - which the status bar would read as
     * "connecting" and never leave. What the user actually means by "am I connected" is whether their
     * voice is going out, and that is the Rust engine. Once the room reports for itself, its own
     * state takes over again, including its failures.
     */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const state = PC_STATE_BY_CONNECTION[this.livekit.state()] ?? 'new';
        return state === 'new' && this.engineUp() ? 'connected' : state;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    readonly localVideoStream = signal<MediaStream | null>(null);
    readonly localScreenStream = signal<MediaStream | null>(null);

    /**
     * What the token this client connected with actually grants.
     *
     * <p>The microphone and camera buttons render from these rather than from locally computed
     * permission. The rights are decided when the token is minted and enforced by the node, so a
     * member whose plan has no video left connects, hears everyone, and cannot turn a camera on
     * however the client is patched - a button drawn from our own arithmetic would be a button that
     * does nothing. Both default to true so a room whose connection has not landed yet does not read
     * as a room that forbids everything.</p>
     */
    readonly canPublishAudio = signal(true);
    readonly canPublishVideo = signal(true);

    // ── Signals ────────────────────────────────────────────────────────────────
    readonly localScreenHasAudio = signal<boolean>(false);
    readonly localScreenAudioMuted = signal<boolean>(false);
    readonly screenEnded$ = new Subject<void>();
    private readonly staleSubscriptionSignal = new Subject<StaleSubscription>();
    /**
     * "Your roster is out of date" - the room service refetches the snapshot and reconciles.
     *
     * <p>Nothing raises it on this path any more, and that is the contract rather than an oversight:
     * the two conditions that used to - a subscribe the backend refused as stale, and a media session
     * it declared spent - are both gone with the SDP relay (design §8). Kept because it is a public
     * surface `VoiceChannelService` subscribes, and because a future condition that genuinely means
     * "refetch" belongs here rather than in a second channel.</p>
     */
    readonly staleSubscription$ = this.staleSubscriptionSignal.asObservable();
    private guildVoiceSvc = inject(GuildVoiceService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private voiceEngine = inject(VoiceEngineService);
    private screenPicker = inject(ScreenPickerService);
    private videoStreamsSignal = signal<Map<string, MediaStream>>(new Map());
    readonly videoStreams = this.videoStreamsSignal.asReadonly();
    private screenStreamsSignal = signal<Map<string, MediaStream>>(new Map());
    readonly screenStreams = this.screenStreamsSignal.asReadonly();

    // ── Observables for cross-service events ───────────────────────────────────
    private screenAudioMutedSignal = signal<Set<string>>(new Set());
    readonly screenAudioMuted = this.screenAudioMutedSignal.asReadonly();

    // ── Room state ─────────────────────────────────────────────────────────────
    /**
     * The Rust publication carrying this channel's audio.
     *
     * Held rather than looked up, because the engine now runs several calls at once and every
     * command has to say which one it means. Isle proximity voice holds its own alongside this.
     */
    private voiceSession: VoiceSession | null = null;
    /**
     * What {@link connect} was called with, so the paths that declare a publication can name the
     * channel without the caller handing it over a second time.
     *
     * Cleared by {@link teardown}: a declaration that fired after we left would announce a track
     * into a channel this client is no longer in.
     */
    private voiceTarget: { guildId: string; channelId: string } | null = null;
    private setupDone = false;
    /** Said once per session rather than per call - see {@link RoomPublishing}. */
    private warnedMissingRoomSurface = false;
    /**
     * The connection the microphone publishes on, and the one the roster records as this
     * participant.
     *
     * <p>Held for the life of the join, unlike the view room's, because the screen share has to land
     * on the <b>same participant</b> as the microphone rather than opening a third identity - the
     * publisher is handed these credentials and the Rust registry answers with the connection it
     * already holds. Cleared by {@link teardown}: a room lives on one node, so carrying it into the
     * next join would be a connection to the wrong machine.</p>
     */
    private primaryConnection: { url: string; token: string } | null = null;

    private localVideoTrack: MediaStreamTrack | null = null;
    private screenShareId: string | null = null;

    /**
     * Remote screen shares' arriving frame rate, by user id - the guild-side twin of
     * `CallWebRtcService.inboundVideoFpsByShare`.
     *
     * <p>Keyed by user, not share, unlike the DM side: the guild side has always identified a screen
     * stream by its owner, and `call-projection.ts`'s `guildScreenShares` builds the guild
     * `CallScreenShare[]` one row per participant (`guildScreenSharers`), so a userId can never
     * collide here the way it can on the DM surface - see `inbound-fps.ts`'s module doc.</p>
     */
    private readonly inboundVideoFpsSignal = signal<Record<string, number>>({});
    readonly inboundVideoFps = this.inboundVideoFpsSignal.asReadonly();
    private statsInterval?: ReturnType<typeof setInterval>;

    /**
     * Which stream the open stats panel is reading, carrying both ids.
     *
     * <p>Both, because the DM service keys by share and this one keys by user, and one host wires
     * either - see the keying note on `CallShareTileComponent.inboundStatsOf`. This service uses
     * `userId` and ignores `shareId`.</p>
     */
    readonly inspected = signal<{shareId: string; userId: string} | null>(null);
    readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);

    /**
     * The previous poll's cumulative `bytesReceived`, per layer, and when it was taken.
     *
     * <p>A rate needs two samples and `inboundStatsFor` sees one report, so the differentiation
     * happens here - the same division `RustMediaService.pollOutbound` draws for the publishing
     * side, and the reason `kbpsBetween` exists at all. Cleared in {@link stopStatsPolling}
     * alongside every other reset, so a panel reopened minutes later differentiates against a fresh
     * baseline instead of against a counter from the previous connection, which would report one
     * absurd spike as its first reading.</p>
     */
    private prevInboundBytes = new Map<string, number>();
    private prevInboundAt = 0;

    // Per-user volume, 0-1. The slider position lives here; the gain it produces lives in Rust.
    private readonly userVolumes = new Map<string, number>();

    // Per-share volume, 0-1. Its own map rather than reusing userVolumes: a stream's audio is a
    // different mixer source than its author's voice (see remoteScreenAudioIds below), and the two
    // must stay adjustable independently.
    private readonly screenVolumes = new Map<string, number>();

    // userId → the mixer source id of their stream's audio, so the per-stream mute can find it.
    private readonly remoteScreenAudioIds = new Map<string, string>();

    // Mixer source id → the publishing identity we are currently pulling it from. Distinguishes a
    // repeated announcement (skip) from a corrected one (resubscribe), which a bare "have we seen
    // this user" set cannot do.
    private readonly subscribedAudioSessions = new Map<string, string>();

    // Mixer source id → a token identifying the newest subscribe attempt for it. Bumped by every
    // new announcement and by cleanup, so a retry that is still sleeping can tell it has been
    // superseded and stop rather than subscribing on behalf of someone who already left.
    private readonly subscribeTokens = new Map<string, number>();

    // Mixer source id → the tail of the chain of engine operations for that source.
    //
    // Every subscribe/unsubscribe for one source runs to completion before the next one starts, and
    // that is load-bearing rather than tidy. The same participant is announced up to three times
    // concurrently - the join snapshot, the refetch after connect, and the live ParticipantJoined -
    // and all three are fire-and-forget. Unserialised they interleaved like this:
    //
    //   A: claims token 1, pulls the track, the engine registers mid 1 -> user
    //   B: sees no recorded subscription (A only records on success), claims token 2, calls the
    //      engine, which returns Ok for a source it already holds *without pulling anything*
    //   A: returns, finds its token superseded, and unsubscribes - taking mid 1's route with it
    //   B: returns Ok and records itself as subscribed
    //
    // The end state is the one in the logs: the SFU is still sending, `tracks 1`, and the engine has
    // no route for it, so every packet is counted `unmapped` and dropped. Worse, the recorded
    // subscription makes every later announcement a no-op, so it never repairs - one participant
    // audible for a second and then permanently silent, on a connection that looks healthy.
    private readonly audioOps = new Map<string, Promise<unknown>>();

    /**
     * Track name → whose video the roster says it is, for every video track this room wants open.
     *
     * <p>An <b>intent</b>, not a record of what is subscribed. A roster announcement names a user and
     * a track name; the SDK subscribes by sid, and the sid for a publication whose `TrackPublished`
     * has not arrived is simply not knowable yet. Holding the intent is what lets
     * {@link applySubscriptions} act on it the moment it becomes knowable, instead of dropping an
     * announcement that is never repeated.</p>
     */
    private readonly wantedVideo = new Map<string, { userId: string; kind: 'video' | 'screen' }>();

    /**
     * Quality of the running screen share, or null when not sharing. Set by the picker and changed
     * by the in-call quality controls.
     */
    readonly screenPreset = signal<StreamPreset | null>(null);
    /**
     * Dimensions of the captured source, kept so a mid-stream resolution change re-solves from the
     * original size. Re-solving from the current output geometry would ratchet the picture down on
     * every change.
     */
    private screenSourceSize: { width: number; height: number } | null = null;
    /** True while the running share is owned by the screen publisher rather than by this service. */
    private rustPublishing = false;
    /** The picker choice behind the running publish, so a resolution change can rebuild it. */
    private rustChoice: ScreenPickerChoice | null = null;
    /**
     * The audio track the Rust publisher actually opened, or null for a video-only share.
     *
     * Held rather than derived, because "the user asked for audio" and "the share has audio" are
     * different facts - the loopback device can be unavailable - and the close path has to name the
     * tracks that exist.
     */
    private rustAudioTrackName: string | null = null;
    private readonly oauth = inject(OAuthService);
    /**
     * The room's ceilings, and where a clamp or a refusal on a publish is filed.
     *
     * <p>Read here rather than passed in because this is the layer that builds the publish: what
     * height and framerate are actually going out is known nowhere else, and the reply that says
     * what the server did with them arrives nowhere else either.</p>
     */
    private readonly voiceLimits = inject(VoiceLimitsService);

    constructor() {
        // A share can end without anything in the app asking it to. In a browser that is the
        // *ordinary* way it ends: the publish runs on `getDisplayMedia`, and Chrome's own "Stop
        // sharing" bar tears the track down and tells us afterwards. Nothing else on this side
        // hears it - a publisher-owned share has no track here to hang an `onended` on. Until this
        // was forwarded, the button stayed lit over a publish that was genuinely gone, and the
        // room was never told the track had stopped.
        //
        // Forwarded into the same subject a user-pressed stop unwinds through, so the one consumer -
        // `VoiceChannelService`, which calls `toggleScreenShare()` - handles it identically: the
        // server is told, and the local state clears.
        //
        // Guarded on `rustPublishing`, and that guard is load-bearing. `RustMediaService` is a
        // singleton shared with the 1:1 call path, so its `publishEnded$` fires for whichever
        // publish ended, not for ours. Unguarded, a call's share ending would raise "your guild
        // share ended" on a service that never started one.
        this.rustMedia.publishEnded$
            .pipe(takeUntilDestroyed())
            .subscribe(() => {
                if (this.rustPublishing) this.screenEnded$.next();
            });

        // Re-arms the poll when a stats panel opens or closes. Runs only when the connection is
        // already polling; there is nothing to re-arm otherwise.
        effect(() => {
            this.inspected();
            if (this.statsInterval !== undefined) this.armStatsInterval();
        });

        // The tiles render off these two maps, and the room is now the only thing that knows what is
        // arriving - there is no `ontrack` to route by mid any more. Rebuilt wholesale on every
        // change rather than patched, because a track that goes has to leave both maps and the room's
        // own map is already the authority on which are still held.
        effect(() => this.projectRemoteStreams());

        // **The other half of every subscription.** A viewer needs two things to pull a track: the
        // roster's word that it wants it, and the room's word on the sid to ask for it by. They
        // arrive over different transports - the roster over SignalR from the API, the publication
        // over the SFU's own signalling - so either can be second, and whichever is second has to
        // re-run the diff.
        //
        // Only the roster side ever did. `subscribeVideo` reconciled on announcement, and if the sid
        // did not resolve yet the track was skipped as "left for the next pass" - a next pass nothing
        // scheduled. The room learning about the publication a moment later was silent, so a camera
        // announced ahead of its own publication was never pulled and the tile stayed black for the
        // rest of the session, with no error on any layer.
        //
        // `untracked`, because reconciling reads `remoteTracks` and subscribing writes it: tracked,
        // this effect would re-run itself on its own subscription for as long as anything changed.
        effect(() => {
            this.livekit.publications();
            untracked(() => this.applySubscriptions());
        });
    }

    // ── Connection setup / teardown ────────────────────────────────────────────

    async connect(guildId: string, channelId: string): Promise<boolean> {
        this.setupDone = false;

        // Start the microphone first - if it is unavailable there is nothing worth joining for.
        //
        // Capture, processing and publishing all happen in Rust, on its own primary connection to the
        // room. Nothing is published from here: other clients learn the track from the roster event
        // the backend emits when that connection publishes "audio".
        //
        // Sending and receiving are independent - the engine has its own connection - so a slow or
        // wedged engine must not be able to hold up subscriptions on the receive side. It could: the
        // engine start waits on ICE in Rust, and when that stalled, every subscribe queued behind it
        // forever and the only symptom was one-way silence with an empty console.
        this.voiceTarget = {guildId, channelId};
        try {
            // Primary, and with no tag: this connection is what the roster records as the
            // participant, so it takes the bare user id. Fetched here rather than in Rust because
            // only this side has the interceptor chain, which refreshes an expired bearer and
            // replays - a token string captured at join time cannot.
            const primary = await firstValueFrom(this.guildVoiceSvc.connection(guildId, channelId, true));
            this.primaryConnection = {url: primary.url, token: primary.token};
            // From the connection that would enforce it. The microphone publishes on this one, so
            // this is the reply that decides whether the button can do anything.
            this.canPublishAudio.set(primary.canPublishAudio);

            this.voiceSession = await this.startEngine(
                {kind: 'guild', guildId, channelId},
                await this.deviceIdentity.deviceId(),
                this.primaryConnection,
            );
            this.engineUp.set(true);

            // **Declare the microphone.** Rust published it to the SFU, which is what makes it
            // audible - and is *all* it makes. Until this call lands the server has no record of
            // this participant publishing anything, so the snapshot carries
            // `publishState: "Joined"` with a null `mediaSessionId` and a null `audioTrackName`.
            //
            // That is not cosmetic. Every other client gates on it: the mobile client treats a
            // publisher who is not `Publishing` as having nothing to pull and skips their screen
            // shares entirely, which presents as a share tile that is drawn from the roster and
            // stays black forever, with no error anywhere. Guide §9 rule 1, and we were the case it
            // is written about.
            //
            // Not fatal if it fails: the audio is already flowing, and tearing the call down over a
            // bookkeeping call would be a worse outcome than a roster that is briefly wrong. The
            // heartbeat asserts the same state every 30 seconds and repairs it.
            await firstValueFrom(
                this.guildVoiceSvc.publish(guildId, channelId, {trackNames: [MICROPHONE_TRACK]}),
            ).catch(e => console.error('[voice] could not declare the microphone', e));
        } catch (e) {
            console.error('[voice] Rust voice engine failed to start', e);
            this.setupDone = true;
            return false;
        }

        await this.openViewRoom(guildId, channelId);
        this.setupDone = true;
        return true;
    }

    /**
     * Join the room as this webview's own secondary connection.
     *
     * <p>Opened at join rather than lazily on the first camera or share, and the reason it used to be
     * lazy is gone with Cloudflare: that SFU created a session the moment one was asked for and
     * dropped any whose peer connection never connected, so a session opened at join and first used
     * minutes later was routinely already spent. The room is subscriber-primary - the connection is
     * what "joined" means, it is negotiated immediately, and it stays up on its own - so opening it
     * late buys nothing and costs the first arriving share a round trip.</p>
     *
     * <p><b>Its own fetch, and never the microphone's.</b> `POST .../voice/connection` is asked twice
     * per join, and that is not a round trip worth saving: minting a token writes no roster row and
     * re-announces nobody. Handing one connection to both would put two clients on one identity, and
     * the SFU disconnects the earlier session under a duplicate identity - the client would kick its
     * own call off the air. Secondary and tagged is what keeps them apart (§2.1).</p>
     *
     * <p>The URL is passed straight through and never cached against a room id. A room lives on
     * exactly one node and this field is the routing answer, so a URL kept from an earlier room is a
     * connection to the wrong machine.</p>
     *
     * <p>A failure here is not a failure to join: the microphone is already publishing and the mixer
     * is already playing the room. What is lost is video, which is what the log line says.</p>
     */
    private async openViewRoom(guildId: string, channelId: string): Promise<void> {
        try {
            const connection = await firstValueFrom(
                this.guildVoiceSvc.connection(guildId, channelId, false, VIEW_TAG));
            // The camera publishes on *this* connection, so this is the reply that decides whether
            // its button can do anything. Its audio grant is the Rust connection's business.
            this.canPublishVideo.set(connection.canPublishVideo);
            await this.livekit.connect({url: connection.url, token: connection.token});
            this.startStatsPolling();
            // Anything announced while the connection was in flight is waiting in `wantedVideo`.
            this.applySubscriptions();
        } catch (e) {
            console.error('[voice] could not join the room for video', e);
        }
    }

    /**
     * Start the microphone on the connection this client just fetched.
     *
     * <p><b>The cast is a seam, not a shortcut.</b> `VoiceStartOptions.livekit` exists and the Tauri
     * adapter forwards it to Rust, but `VoiceEngineService.start` still takes four arguments and
     * drops the fifth - and that file is not this one's to change. Passed anyway and pinned by a
     * test, so the day the engine grows the parameter this works with the `as` removed and nothing
     * else moved. Until then the microphone falls back to the route Rust takes when no connection is
     * given, which is the Cloudflare one, and it 404s.</p>
     */
    private startEngine(
        target: VoiceTarget,
        deviceId: string,
        livekit: { url: string; token: string },
    ): Promise<VoiceSession> {
        // Called directly, deliberately. This was briefly a cast, because the engine's signature had
        // not yet grown the parameter - and that cast is precisely what turns "forgot the
        // connection" from a compile error into a 404 three layers down inside Rust. The whole
        // reason the connection is a typed argument rather than ambient state is to make that
        // omission unbuildable, so a cast here would give away the only guard there is.
        return this.voiceEngine.start(
            target,
            this.apiConfig.baseUrl(),
            this.oauth.getAccessToken(),
            deviceId,
            livekit,
        );
    }

    /**
     * The publish half of the room, or an empty object when the wrapper does not carry it.
     *
     * <p>See {@link RoomPublishing}. Said once and loudly rather than per call: a missing method here
     * is a build that cannot publish a camera or resolve a roster row to a sid at all, which is a
     * wiring fault and not a condition to degrade quietly around.</p>
     */
    private get roomMedia(): Partial<RoomPublishing> {
        const room = this.livekit as unknown as Partial<RoomPublishing>;
        if (!this.warnedMissingRoomSurface && typeof room.publishTrack !== 'function') {
            this.warnedMissingRoomSurface = true;
            console.error(
                '[voice] the room wrapper carries no publish/publications surface - ' +
                'cameras cannot be published and roster rows cannot be resolved to track sids',
            );
        }
        return room;
    }

    // ── Stats polling ────────────────────────────────────────────────────────

    private startStatsPolling(): void {
        this.stopStatsPolling();
        this.armStatsInterval();
    }

    /**
     * (Re)arm the poll at the cadence the current inspection state wants.
     *
     * <p>1s while a stats panel is open, 2s otherwise. A diagnostics readout refreshing every two
     * seconds is hard to read against a stream that is visibly stuttering, and the faster rate is
     * only paid for while somebody is looking.</p>
     */
    private armStatsInterval(): void {
        clearInterval(this.statsInterval);
        const period = this.inspected() ? 1000 : 2000;
        this.statsInterval = setInterval(() => void this.pollStats(), period);
    }

    /**
     * Stop polling and forget everything the poll produced.
     *
     * <p><b>`inspected` is cleared here too, and that is not tidiness.</b> This service is
     * `providedIn: 'root'`, so it outlives any one call: a tile destroyed with its panel still open
     * - the sharer stops, or the user navigates away - leaves `inspected` set with nobody left to
     * clear it, and {@link armStatsInterval} then goes on choosing the 1s diagnostics cadence for
     * the rest of the session, in the next call as well as this one. Clearing the inspection when
     * the connection it belonged to goes away is what bounds that to the panel's actual lifetime.
     * The tile clears it too, on its own teardown; both halves are needed, because either one alone
     * leaves a path where nothing does.</p>
     */
    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.inboundVideoFpsSignal.set({});
        this.inspected.set(null);
        this.inspectedStats.set(null);
        this.prevInboundBytes.clear();
        this.prevInboundAt = 0;
    }

    /**
     * Read every held screen share's counters, one report per track.
     *
     * <p>Per track rather than per connection, because that is what the SDK answers - and it is why
     * {@link midOfReport} exists: the mid used to arrive on the negotiate reply and now has to be
     * read back out of the report it keys.</p>
     */
    private async pollStats(): Promise<void> {
        const fps: Record<string, number> = {};
        let sample: StreamStatsSample | null = null;
        const inspectedUser = this.inspected()?.userId ?? null;

        for (const track of this.livekit.remoteTracks().values()) {
            if (describeTrack(track.publication.trackName).kind !== 'screen') continue;
            const report = await track.publication.videoTrack?.getRTCStatsReport();
            if (!report) continue;
            const mid = midOfReport(report);
            if (!mid) continue;

            const owners: ReadonlyMap<string, InboundTrackOwner> =
                new Map([[mid, {userId: track.userId, kind: 'screen' as const}]]);
            Object.assign(fps, inboundScreenFpsByUser(report, owners));
            sample ??= detailedStatsFor(report, owners, inspectedUser);
        }

        this.inboundVideoFpsSignal.set(fps);
        this.inspectedStats.set(this.withMeasuredBitrate(sample));
    }

    /**
     * Turn this poll's cumulative `bytesReceived` into a per-layer `kbps`, against the last one.
     *
     * <p>The first poll of a freshly opened panel has no predecessor and so produces no rate at
     * all, which is the honest answer: `kbpsBetween` returns undefined rather than zero, and the
     * bitrate row is simply absent for one tick instead of claiming the stream is silent. Kept
     * structurally identical to `CallWebRtcService.withMeasuredBitrate` on purpose - the two
     * services are deliberate near-twins and drift between them is the thing that hides bugs.</p>
     */
    private withMeasuredBitrate(snapshot: StreamStatsSample | null): StreamStatsSnapshot | null {
        if (!snapshot) return null;

        const now = Date.now();
        const dt = this.prevInboundAt ? (now - this.prevInboundAt) / 1000 : 0;

        for (const layer of snapshot.layers) {
            const key = layer.rid ?? layer.mid ?? '';
            const bytes = layer.bytesReceived;
            if (bytes === undefined) continue;
            const rate = kbpsBetween(bytes, this.prevInboundBytes.get(key), dt);
            if (rate !== undefined) layer.kbps = rate;
            this.prevInboundBytes.set(key, bytes);
        }
        this.prevInboundAt = now;

        return snapshot;
    }

    /**
     * What this client is actually publishing, for the heartbeat's state assertion.
     *
     * <p>Deliberately the *Rust* session and not this room's identity. The webview's connection is
     * secondary; the microphone lives on the Rust one, and that is the participant peers are told to
     * pull from. Asserting this room's identity would have the server hand peers a participant with
     * no audio track on it.</p>
     *
     * <p>Null while not publishing, which is the honest thing to send - the server corrects its
     * record from it and tells peers to drop us. <b>An empty `mediaSessionId` is not that.</b> The
     * engine answers `""` on the LiveKit arm rather than fabricating an id, because identity is the
     * room's to assign; publishing state is driven from `publishState` and never from whether this
     * string is blank.</p>
     */
    get publishedMedia(): { mediaSessionId: string; audioTrackName: string } | null {
        if (!this.voiceSession) return null;
        return {
            mediaSessionId: this.voiceSession.mediaSessionId,
            audioTrackName: this.voiceSession.trackName,
        };
    }

    /**
     * Names of all local tracks published from *this* client's webview, for the unpublish call.
     *
     * The microphone is not among them: it lives on the Rust connection, which closes its own track.
     */
    getActiveTrackNames(): string[] {
        const names: string[] = [];
        if (this.localVideoTrack) names.push(CAMERA_TRACK);
        if (this.screenShareId) {
            names.push(screenTrackName(this.screenShareId));
            if (this.rustAudioTrackName) names.push(screenAudioTrackName(this.screenShareId));
        }
        return names;
    }

    teardown(): void {
        this.subscribedAudioSessions.clear();
        this.wantedVideo.clear();
        // Dropped rather than awaited: the publication below is about to be stopped, which removes
        // every source on it, and anything still queued is for a channel that no longer exists.
        this.audioOps.clear();
        // Bumped, not cleared: a cleared map reads as token 0 to a retry that is still sleeping,
        // which is the value it would match if it was the first attempt for that source.
        this.subscribeTokens.forEach((token, id) => this.subscribeTokens.set(id, token + 1));

        // Ends this channel's publication and every subscription on it in one call. Only this one:
        // Isle proximity voice may be running on the same microphone and must survive leaving a
        // guild channel.
        if (this.voiceSession) void this.voiceEngine.stop(this.voiceSession);
        this.voiceSession = null;
        this.voiceTarget = null;
        this.primaryConnection = null;
        this.engineUp.set(false);
        this.localVideoTrack?.stop();
        // The publisher only, and only when one is running. The canvas capture this used to stop
        // alongside it is gone with the webview publish path - every share is the publisher's now,
        // on both hosts - and calling into a capture nothing started would be reaching for a
        // pipeline that no longer exists.
        if (this.rustPublishing) void this.rustMedia.stopScreenPublish();

        this.localVideoTrack = null;
        this.rustPublishing = false;
        this.rustChoice = null;
        this.rustAudioTrackName = null;
        this.screenShareId = null;
        this.screenSourceSize = null;
        this.screenPreset.set(null);

        this.stopStatsPolling();
        void this.livekit.disconnect();
        this.participantsWithAudio.set(new Set());
        this.canPublishAudio.set(true);
        this.canPublishVideo.set(true);
        this.setupDone = false;

        this.videoStreamsSignal.set(new Map());
        this.screenStreamsSignal.set(new Map());
        this.localVideoStream.set(null);
        this.localScreenStream.set(null);
        this.localScreenHasAudio.set(false);
        this.localScreenAudioMuted.set(false);
        this.screenAudioMutedSignal.set(new Set());
    }

    /**
     * Open or close the microphone for this channel.
     *
     * Routed through here rather than called on the engine directly, because push-to-talk is now
     * per call: the engine needs to be told *which* one, and this service is what holds it.
     */
    setPttOpen(open: boolean): void {
        if (this.voiceSession) void this.voiceEngine.setPttOpen(this.voiceSession, open);
    }

    /**
     * Everyone we currently hold a subscription for, so a snapshot can tell who has left.
     *
     * Screen-share audio is excluded: those sources are keyed by track name rather than by user, and
     * they are torn down with their share.
     */
    subscribedUserIds(): string[] {
        const ids = new Set<string>();
        for (const [id] of this.subscribedAudioSessions) {
            if (!id.startsWith('screen-')) ids.add(id);
        }
        for (const [, want] of this.wantedVideo) ids.add(want.userId);
        return [...ids];
    }

    /** Cleans up all per-participant resources when a remote user leaves. */
    cleanupParticipant(userId: string): void {
        // Drops their source from the mixer, their entry from the roster maps, and their volume.
        //
        // Queued behind any subscribe still running for them, or the drop lands first and the
        // subscribe it was meant to undo finishes afterwards - putting a participant who has left
        // back in the mix. The token bumped below is what stops that subscribe recording itself.
        void this.queueAudioOp(userId, () => this.dropSource(userId));
        // Forget the identity they were on, so rejoining resubscribes rather than being skipped as
        // a duplicate.
        this.subscribedAudioSessions.delete(userId);
        // Invalidate any retry still sleeping for them. Without this, someone who leaves during
        // the backoff is resubscribed seconds later and stays in the mix until the next teardown.
        this.subscribeTokens.set(userId, (this.subscribeTokens.get(userId) ?? 0) + 1);
        // Same for their video: the intent has to go before the diff runs, or the reconcile below
        // re-subscribes whatever of theirs the room still lists.
        for (const [name, want] of this.wantedVideo) {
            if (want.userId === userId) this.wantedVideo.delete(name);
        }
        this.applySubscriptions();

        this.videoStreamsSignal.update(m => {
            const n = new Map(m);
            n.delete(userId);
            return n;
        });
        this.screenStreamsSignal.update(m => {
            const n = new Map(m);
            n.delete(userId);
            return n;
        });
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            n.delete(userId);
            return n;
        });
        this.participantsWithAudio.update(s => {
            const n = new Set(s);
            n.delete(userId);
            return n;
        });
    }

    // ── Track subscription ─────────────────────────────────────────────────────

    /**
     * Pull remote audio into the Rust mixer.
     *
     * Nothing arrives on this room: audio - microphones and every `screen-audio-*` track alike - is
     * pulled on the Rust connection, decoded, jitter-buffered and mixed there, and leaves through the
     * output device Rust opened. Two transports playing the same participant is double playout, and
     * the second copy is not muteable from any control the user can see.
     *
     * `guildId`/`channelId` are gone from the signature - the Rust session already knows its target.
     */
    async subscribeAudio(
        targets: { userId: string; mediaSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' }[],
    ): Promise<void> {
        // Concurrently, because a subscribe now retries for several seconds before giving up.
        // Sequentially, one participant losing the publish race would hold up everyone announced
        // alongside them - which is exactly what happens when we join a busy channel and the
        // backfill announces the whole room at once.
        await Promise.all(targets.map(target => this.subscribeOne(target)));
    }

    /**
     * Drop a source from this channel's publication.
     *
     * Null-safe because participants leave in paths that also run after teardown - a WS event that
     * arrives just after the channel was left would otherwise reach for a session that is gone.
     */
    private async dropSource(id: string): Promise<void> {
        if (this.voiceSession) await this.voiceEngine.unsubscribe(this.voiceSession, id);
    }

    /**
     * Wait for this channel's publication to exist, rather than dropping a subscribe that arrived
     * before it.
     *
     * The backend backfills the room the moment `join` returns, and `join` is awaited *before*
     * `connect` - so every participant already in the channel is announced while `voiceSession` is
     * still null. An announcement is never repeated, so dropping one made that participant
     * permanently inaudible for the session. Bounded by the same schedule a subscribe retries on,
     * because a connect that has not produced a session in that long is not going to.
     */
    private async awaitSession(): Promise<VoiceSession | null> {
        if (this.voiceSession) return this.voiceSession;
        for (const delay of SUBSCRIBE_RETRY_DELAYS_MS) {
            await new Promise(r => setTimeout(r, delay));
            if (this.voiceSession) return this.voiceSession;
        }
        return this.voiceSession;
    }

    /**
     * Run one engine operation for a source, after every operation already queued for it.
     *
     * See {@link audioOps}. A failure is contained to its own caller: the chain itself is kept
     * settled, or one rejected subscribe would take every later operation for that source with it.
     */
    private queueAudioOp<T>(id: string, op: () => Promise<T>): Promise<T> {
        const next = (this.audioOps.get(id) ?? Promise.resolve()).catch(() => {
        }).then(op);
        this.audioOps.set(id, next.catch(() => {
        }));
        return next;
    }

    private async subscribeOne(
        target: { userId: string; mediaSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' },
    ): Promise<void> {
        // Captured once: the channel can be left mid-retry, and the loop below must not resubscribe
        // onto a publication that has since been replaced by a different channel's.
        //
        // Waited for *outside* the queue. The first announcement of a channel arrives before the
        // engine has a session and waits seconds for one; inside the queue that wait would hold up
        // every other announcement for the same source behind it.
        const session = await this.awaitSession();
        if (!session) {
            console.error('[voice] dropped a subscribe - no session after waiting', target);
            return;
        }

        // Voice keys on the user; a stream's audio keys on its track name, so muting a stream
        // does not mute the voice of whoever is streaming.
        const id = target.kind === 'screenAudio' ? target.trackName : target.userId;

        return this.queueAudioOp(id, () => this.subscribeQueued(session, id, target));
    }

    /**
     * One subscribe, with no other operation for the same source in flight - see {@link audioOps}.
     *
     * The dedupe check below is only meaningful here: it reads a record written on *success*, so
     * outside the queue it is blind for exactly as long as a subscribe takes, which is the entire
     * window duplicate announcements arrive in.
     */
    private async subscribeQueued(
        session: VoiceSession,
        id: string,
        target: { userId: string; mediaSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' },
    ): Promise<void> {
        // A participant is announced twice: once live when they publish, and once more out of
        // the stored record when *we* join and the backend backfills everyone already present.
        // The two do not always agree - the live announcement carries the identity that was just
        // passed in, the backfill reads whatever is on the participant row, which is stale if they
        // rejoined. Acting on that difference is the only recovery path there is.
        const previous = this.subscribedAudioSessions.get(id);
        if (previous === target.mediaSessionId) return;
        if (previous !== undefined) {
            // The old subscription points at a participant that is no longer publishing. Drop it,
            // or the mixer keeps a dead source - one leaked route every time somebody rejoins.
            console.warn('[voice] publishing identity changed, resubscribing', {
                id, from: previous, to: target.mediaSessionId,
            });
            await this.voiceEngine.unsubscribe(session, id);
            this.subscribedAudioSessions.delete(id);
        }

        // Claim this source. A later announcement, or the participant leaving, invalidates the
        // token and any attempt still sleeping between retries drops out instead of resurrecting
        // a subscription for someone who is no longer here.
        const token = (this.subscribeTokens.get(id) ?? 0) + 1;
        this.subscribeTokens.set(id, token);

        for (let attempt = 0; ; attempt++) {
            if (this.subscribeTokens.get(id) !== token) return;
            try {
                await this.voiceEngine.subscribe(session, id, target.mediaSessionId, target.trackName);
                if (this.subscribeTokens.get(id) !== token) {
                    // Superseded while the call was in flight. Drop what we just took, or it
                    // outlives the participant it belongs to.
                    await this.voiceEngine.unsubscribe(session, id);
                    return;
                }
                // Only after it succeeds. Recording a failed subscribe would make the retry above
                // skip the very announcement that could have carried a working identity.
                this.subscribedAudioSessions.set(id, target.mediaSessionId);
                if (target.kind === 'screenAudio') {
                    this.remoteScreenAudioIds.set(target.userId, id);
                    // A stream that starts while its author is already muted must stay muted.
                    if (this.screenAudioMutedSignal().has(target.userId)) {
                        void this.voiceEngine.setUserVolume(id, 0);
                    } else {
                        // Re-apply the stored slider position, exactly as the voice branch below
                        // does: Rust starts every source at unity, and a volume set before this
                        // share existed (or before it restarted at a new track name) would
                        // otherwise be silently lost.
                        const volume = this.screenVolumes.get(target.userId);
                        if (volume !== undefined) void this.voiceEngine.setUserVolume(id, volume);
                    }
                } else {
                    this.participantsWithAudio.update(s => new Set(s).add(target.userId));
                    // Re-apply the stored slider position: Rust starts every source at unity, and a
                    // volume set before this participant joined would otherwise be silently lost.
                    const volume = this.userVolumes.get(target.userId);
                    if (volume !== undefined) void this.voiceEngine.setUserVolume(id, volume);
                }
                return;
            } catch (e) {
                if (attempt < SUBSCRIBE_RETRY_DELAYS_MS.length) {
                    // Expected, not exceptional. The roster announces a publisher as soon as the room
                    // records the publication, which can reach us before the SFU's own
                    // `TrackPublished` reaches the Rust room - so an early subscribe names a track
                    // that room has not been told about yet.
                    console.warn('[voice] subscribe failed, retrying', {
                        id, attempt: attempt + 1, retryInMs: SUBSCRIBE_RETRY_DELAYS_MS[attempt],
                    }, e);
                    await new Promise(r => setTimeout(r, SUBSCRIBE_RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                // Loud, and it stays loud. The retries are exhausted, so this participant is
                // unhearable until they republish - and a silent version of this exact failure is
                // what cost a full debugging session in phase 1.
                console.error('[voice] subscribe failed', {
                    id, ...target, attempts: SUBSCRIBE_RETRY_DELAYS_MS.length + 1,
                }, e);
                return;
            }
        }
    }

    /**
     * Want a remote camera or screen track open on this room.
     *
     * <p>Records the intent and reconciles. It cannot fail and it cannot be too early: a roster
     * announcement can arrive before the connection is up or before the SFU has told this room the
     * publication exists, and either way the intent is held and applied by the next reconcile rather
     * than dropped. Announcements are never repeated, which is what makes dropping one permanent.</p>
     *
     * <p><b>Video only.</b> A `screen-audio-*` track named here would be refused by the room anyway -
     * the Rust connection already plays it into the mixer - so it is filtered out here where the
     * reason can be stated rather than counted.</p>
     */
    subscribeVideo(
        _guildId: string,
        _channelId: string,
        userId: string,
        _mediaSessionId: string,
        trackName: string,
        kind: 'video' | 'screen',
    ): Promise<void> {
        const described = describeTrack(trackName);
        if (described.kind !== 'video' && described.kind !== 'screen') {
            console.warn('[voice] not pulling an audio track onto the view room', {trackName});
            return Promise.resolve();
        }

        this.wantedVideo.set(trackName, {userId, kind});
        this.applySubscriptions();
        return Promise.resolve();
    }

    /**
     * Bring what the room is pulling into line with what the roster asked for.
     *
     * <p>By diffing, never by rebuilding: subscribe what is newly wanted, close what is no longer.
     * A rebuild would drop and re-pull every tile on any change, which is a black frame on every
     * screen for every viewer each time one person turns a camera on.</p>
     *
     * <p>A track whose sid cannot be resolved is left for the next pass rather than logged as a
     * failure - it is the ordinary state of a publication whose announcement beat the SFU's.</p>
     */
    private applySubscriptions(): void {
        // What this pass decided, as one line rather than none.
        //
        // **Every way this path fails is silent**, which is why a camera that never appears has
        // repeatedly cost days: an unresolved sid is skipped as ordinary, a refused `setSubscribed`
        // returns `false` and is dropped, and an intent nobody ever announced simply is not here. All
        // three look identical from the outside - a tile that stays empty - and none of them is an
        // error. This says which one happened.
        const resolved: string[] = [];
        const unresolved: string[] = [];
        const refused: string[] = [];

        for (const [trackName, want] of this.wantedVideo) {
            const trackSid = this.sidOf(want.userId, trackName);
            if (!trackSid) {
                unresolved.push(`${want.userId}/${trackName}`);
                continue;
            }
            if (this.livekit.setSubscribed(trackSid, true)) resolved.push(`${want.userId}/${trackName}`);
            else refused.push(`${want.userId}/${trackName}@${trackSid}`);
        }
        for (const track of this.livekit.remoteTracks().values()) {
            if (!this.wantedVideo.has(track.publication.trackName)) {
                this.livekit.setSubscribed(track.trackSid, false);
            }
        }

        // `wanted 0` is the roster never asking - look at the announcement, not at this room.
        // `unresolved` is the room not knowing the publication yet, which the reconcile on
        // `livekit.publications` is there to retry. `refused` is this room saying no.
        console.info(
            `[voice] video reconcile: wanted ${this.wantedVideo.size}`
            + `, pulling ${resolved.length}${resolved.length ? ` [${resolved.join(', ')}]` : ''}`
            + (unresolved.length ? `, no sid yet [${unresolved.join(', ')}]` : '')
            + (refused.length ? `, refused [${refused.join(', ')}]` : ''),
        );
    }

    /**
     * The sid behind a roster row, or null while the room has not been told the publication exists.
     *
     * <p>Two places to look, and both are needed. A track already held is in the room's own map,
     * which is the only one populated without {@link RoomPublishing}; everything not yet pulled is
     * reachable only through it.</p>
     */
    private sidOf(userId: string, trackName: string): string | null {
        for (const track of this.livekit.remoteTracks().values()) {
            if (track.userId === userId && track.publication.trackName === trackName) return track.trackSid;
        }
        for (const publication of this.roomMedia.publicationsOf?.(userId) ?? []) {
            if (publication.trackName === trackName) return publication.trackSid;
        }
        return null;
    }

    /**
     * Rebuild the two stream maps the tiles render from, off what the room currently holds.
     *
     * <p>{@link describeTrack} is the only thing that decides what a name means, here as everywhere:
     * it tests `screen-audio-` before `screen-`, so a share's audio can never be filed as the video
     * of a share whose id happens to start with `audio-`. An audio track cannot reach these maps at
     * all - it is never subscribed on this room - but the branch is written on the description rather
     * than on that assumption.</p>
     */
    private projectRemoteStreams(): void {
        const video = new Map<string, MediaStream>();
        const screen = new Map<string, MediaStream>();

        for (const track of this.livekit.remoteTracks().values()) {
            const described = describeTrack(track.publication.trackName);
            if (described.kind !== 'video' && described.kind !== 'screen') continue;
            const media = track.publication.track?.mediaStreamTrack;
            if (!media) continue;
            (described.kind === 'screen' ? screen : video).set(track.userId, new MediaStream([media]));
        }

        this.videoStreamsSignal.set(video);
        this.screenStreamsSignal.set(screen);
    }

    // ── Local media controls ───────────────────────────────────────────────────

    /**
     * One call, because the mixer silences everything at once rather than per element.
     *
     * Note this deafens *output only* - the capture chain is untouched, so deafen still does not
     * stop you transmitting. Mute is a separate control, as it was before.
     */
    setDeafened(isDeafened: boolean): void {
        void this.voiceEngine.setDeafened(isDeafened);
    }

    /**
     * Open the camera, publish it, and declare it.
     *
     * <p>Two steps and they answer different questions. The SDK publish is what puts pixels on the
     * wire; `POST .../voice/publish` is what puts this client on the roster as publishing, and is
     * where the entitlement answer arrives. A `200` carrying `degradations` is a publish that
     * <b>worked, smaller</b> - the camera is live at the rung the server granted, nothing rolls back,
     * and the capture is re-encoded to match rather than going on sending pixels the room will drop.
     * A `403` is a refusal that could not degrade: the token this client connected with does not
     * permit it either, so nobody would receive it whatever is retried, and the local track is
     * stopped.</p>
     */
    async publishCamera(guildId: string, channelId: string): Promise<string | null> {
        if (!this.canPublishVideo()) {
            console.warn('[voice] the token for this room does not permit video');
            return null;
        }

        const publishTrack = this.roomMedia.publishTrack;
        if (typeof publishTrack !== 'function') return null;

        try {
            // Honour the camera picked in settings; this used to hardcode `video: true` and always
            // open the system default.
            const stream = await navigator.mediaDevices.getUserMedia({
                video: await this.audioSettings.buildVideoConstraint(),
                audio: false,
            });
            this.localVideoTrack = stream.getVideoTracks()[0];
            this.localVideoStream.set(new MediaStream([this.localVideoTrack]));

            // The SDK owns the send-side encodings now - the ladder, the codec preference and the
            // start bitrate that `webrtc-encoding.ts` used to hand the transceiver.
            await publishTrack(this.localVideoTrack, CAMERA_TRACK);

            const granted = await firstValueFrom(this.guildVoiceSvc.publish(guildId, channelId, {
                trackNames: [CAMERA_TRACK],
                // What the camera actually opened at, not what was asked for: the device negotiates
                // its own settings against the constraint, and stating the request would have the
                // server clamp against a resolution nothing is sending.
                video: trackIntent(this.localVideoTrack),
            }));

            // A clamped publish is a success carrying a note. Nothing above this line rolls back on
            // account of it - the camera is live, at the rung the server granted.
            this.voiceLimits.noteDegradations(granted);
            await this.reencodeTo(granted.height, granted.framerate);
            return CAMERA_TRACK;
        } catch (err) {
            // A refusal is not a broken camera, and must never reach the generic failure path.
            // The device is released either way: leaving the capture running behind a publish that
            // did not happen leaves the machine's camera light on with nothing on screen.
            this.voiceLimits.noteDenial(err);
            await this.roomMedia.unpublishTrack?.(CAMERA_TRACK).catch(() => {
            });
            this.releaseCameraTrack();
            return null;
        }
    }

    /**
     * Re-encode the running camera to the rung the server granted.
     *
     * <p>`applyConstraints` rather than a republish: the track, its sid and every viewer's
     * subscription survive it, so a clamp costs one resolution change rather than a tile that leaves
     * the grid and comes back. Null on either half means the server expressed no preference, which
     * is the ordinary case and leaves the capture exactly where the device put it.</p>
     */
    private async reencodeTo(height: number | null, framerate: number | null): Promise<void> {
        const track = this.localVideoTrack;
        if (!track || height === null || framerate === null) return;
        if (typeof track.applyConstraints !== 'function') return;
        await track.applyConstraints({height, frameRate: framerate}).catch(e =>
            console.warn('[voice] could not re-encode the camera to the granted rung', e));
    }

    /** Drop a camera capture that never became a publication. */
    private releaseCameraTrack(): void {
        this.localVideoTrack?.stop();
        this.localVideoTrack = null;
        this.localVideoStream.set(null);
    }

    async closeCamera(guildId: string, channelId: string): Promise<void> {
        if (!this.localVideoTrack) return;
        await this.roomMedia.unpublishTrack?.(CAMERA_TRACK).catch(() => {
        });
        this.releaseCameraTrack();
        // Best effort, and after the media has already stopped: the declaration is what makes peers
        // drop the tile rather than waiting on a track that has ended, and a failure here costs a
        // stale roster row that the next snapshot corrects.
        await firstValueFrom(this.guildVoiceSvc.unpublish(guildId, channelId, [CAMERA_TRACK]))
            .catch(() => {
            });
    }

    async publishScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
        try {
            const choice = await this.screenPicker.show();
            if (!choice) return null;

            const {sourceWidth, sourceHeight} = choice;
            // Clamped before capture, not after. The picker's own preset outlives the room it was
            // chosen in - it is a saved preference - so a user who last shared at 1080p60 on one
            // server arrives at a 720p30 one still asking for it. Encoding at 1080p and being
            // clamped is a minute of a viewer's bandwidth spent on pixels nobody receives.
            const preset = clampPreset(choice.preset, this.voiceLimits.videoCeiling());
            this.screenPreset.set(preset);
            this.screenSourceSize = {width: sourceWidth, height: sourceHeight};

            return await this.publishScreenFromRust(guildId, channelId, {...choice, preset});
        } catch (err) {
            this.voiceLimits.noteDenial(err);
            return null;
        }
    }

    async closeScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
        if (!this.rustPublishing) return null;

        // The publisher owns its own connection and stops its own tracks; what is left here is the
        // declaration, which is what makes peers drop the tile rather than waiting on media that has
        // ended.
        const shareId = this.screenShareId ?? 'share';
        const trackNames = [screenTrackName(shareId)];
        if (this.rustAudioTrackName) trackNames.push(screenAudioTrackName(shareId));

        await this.rustMedia.stopScreenPublish();
        this.rustPublishing = false;
        this.rustChoice = null;
        this.rustAudioTrackName = null;
        this.localScreenHasAudio.set(false);
        this.localScreenAudioMuted.set(false);
        this.screenShareId = null;
        this.screenSourceSize = null;
        this.screenPreset.set(null);

        await firstValueFrom(this.guildVoiceSvc.unpublish(guildId, channelId, trackNames))
            .catch(() => {
            });
        return {shareId};
    }

    /**
     * Publish the screen from the {@link ScreenPublisher} port, and declare what it published.
     *
     * <p>The port owns the capture, the encoder and the connection; nothing is published from this
     * webview. The local tile therefore has no stream to show and falls back to its placeholder - the
     * sharer's own preview comes off the encoder tap instead, which is why it survived the move.</p>
     *
     * <p>The declaration is made here rather than in Rust because this is the side with the
     * interceptor chain: a token captured at publish time cannot refresh itself, and the entitlement
     * answer then has one place to be handled rather than two.</p>
     */
    private async publishScreenFromRust(
        guildId: string,
        channelId: string,
        choice: ScreenPickerChoice,
    ): Promise<{ shareId: string } | null> {
        // The microphone's connection, so the share lands on the same participant rather than
        // opening a third identity. Without one there is nothing to publish onto: the route the
        // publisher would otherwise take no longer exists.
        const livekit = this.primaryConnection;
        if (!livekit) {
            console.error('[voice] cannot share a screen before the room connection exists');
            return null;
        }

        const shareId = crypto.randomUUID();
        try {
            const published = await this.rustMedia.startScreenPublish(
                publishOptions(
                    choice,
                    shareId,
                    this.apiConfig.baseUrl(),
                    this.oauth.getAccessToken(),
                    await this.deviceIdentity.deviceId(),
                    {guildId, channelId},
                    this.voiceLimits.videoCeiling(),
                    livekit,
                ),
            );
            console.log(`[voice] screen publisher live on ${published.encoder}`, published);
            this.screenShareId = shareId;
            this.rustPublishing = true;
            this.rustChoice = choice;
            // What was actually published, not what was asked for: the loopback device can be
            // unavailable, and the share is then video-only. Driving the UI from `choice.shareAudio`
            // would show a speaker icon on a share that carries no sound.
            this.rustAudioTrackName = published.audioTrackName;
            this.localScreenHasAudio.set(published.audioTrackName !== null);
            this.localScreenAudioMuted.set(false);

            const trackNames = [screenTrackName(shareId)];
            if (published.audioTrackName) trackNames.push(screenAudioTrackName(shareId));

            const granted = await firstValueFrom(this.guildVoiceSvc.publish(guildId, channelId, {
                trackNames,
                video: this.screenIntent(choice),
            }));
            this.voiceLimits.noteDegradations(granted);
            return {shareId};
        } catch (e) {
            console.error('[voice] screen publish failed', e);
            // A `403` on the declaration is a refusal the room could not degrade, so the media has to
            // stop: nobody receives it whatever the client does. The Rust publisher hands its own
            // failures back across the Tauri boundary as plain strings, so a body does not survive
            // that trip and files nothing here - what covers that path is the pre-flight, where the
            // share button is already disabled in a room whose plan would refuse it.
            this.voiceLimits.noteDenial(e);
            if (this.rustPublishing) await this.rustMedia.stopScreenPublish().catch(() => {
            });
            this.rustPublishing = false;
            this.rustChoice = null;
            this.rustAudioTrackName = null;
            this.screenShareId = null;
            this.localScreenHasAudio.set(false);
            this.screenPreset.set(null);
            this.screenSourceSize = null;
            return null;
        }
    }

    /**
     * What a share is about to send: the *solved* capture height, not the preset's nominal one.
     *
     * <p>An ultrawide fitted into a 1080p box encodes 540 lines, and declaring 1080 there has the
     * server cap a share already inside its rung. Solved from the same inputs `publishOptions` uses,
     * so the number declared and the number encoded cannot drift. Nothing here maps a picker option
     * onto a rung; the server owns that.</p>
     */
    private screenIntent(choice: ScreenPickerChoice): VideoPublishIntentDto | undefined {
        const geometry = solveGeometry(
            choice.sourceWidth, choice.sourceHeight, choice.preset.resolution,
            this.voiceLimits.videoCeiling());
        if (geometry.height <= 0) return undefined;
        return {height: geometry.height, framerate: choice.preset.framerate};
    }

    /**
     * Change stream quality mid-share, the way Discord's stream-settings cog does.
     *
     * <p>Nothing here restarts anything. A framerate change is read by the capture loop on its next
     * frame; a resolution change retypes the encoder in place at a frame boundary. The connection,
     * the track and therefore the share id all survive both, so a viewer sees one keyframe at a new
     * size and is told nothing.</p>
     *
     * <p>A resolution change used to tear the publish down and start a fresh one. That meant a new
     * share id, a stopped-then-started pair on the wire, and every viewer's tile leaving the grid
     * for one to four seconds - long enough that anyone watching it maximised was left on an empty
     * stage. See `ScreenPublisher.setGeometry`.</p>
     *
     * <p>The one thing that <b>is</b> announced is the new size, through `PUT .../voice/video`. A
     * ceiling computed once at publish time is one a later resolution change walks straight past, and
     * this is the only thing that tells the server about it. It refuses nothing - the cap applies to
     * what leaves the room - so there is no error path and nothing rolls back.</p>
     */
    async setScreenPreset(requested: StreamPreset): Promise<void> {
        const previous = this.screenPreset() ?? DEFAULT_STREAM_PRESET;
        // Both pickers - this bar and the pre-share dialog - already disable what the rung does not
        // permit, so this only catches a ceiling that moved between the render and the click, and a
        // hotkey, which passes through no picker at all.
        const preset = clampPreset(requested, this.voiceLimits.videoCeiling());
        this.screenPreset.set(preset);
        // The bar is where quality is chosen now - the pre-share dialog only picks a source - so the
        // choice has to outlive the share. `requested`, not `preset`: see `rememberPreset`.
        this.screenPicker.rememberPreset(requested);

        if (!this.rustPublishing) return;

        // Framerate is live - the capture loop re-reads it every frame.
        if (preset.framerate !== previous.framerate) {
            await this.rustMedia.setPublishFps(preset.framerate);
        }
        // The mode moves no number the encoder is built from, so it needs its own trigger or the
        // bar's row would look live and change nothing until the next share. It rides the same
        // retype as the geometry rather than getting a call of its own, so a change to both is
        // one frame boundary and not two.
        const retype = preset.resolution !== previous.resolution || preset.content !== previous.content;
        if (retype && this.screenSourceSize) {
            const {width, height} = this.screenSourceSize;
            const box = solveGeometry(
                width, height, preset.resolution, this.voiceLimits.videoCeiling());
            await this.rustMedia.setPublishSpec({
                width: box.width,
                height: box.height,
                kbps: bitrateFor(preset),
                content: preset.content,
            });
        }
        // Kept in step with what the encoder is now producing, so a publish that genuinely does
        // restart later - sharing a different source - opens at the resolution the user is
        // watching rather than the one they first picked.
        if (this.rustChoice) this.rustChoice = {...this.rustChoice, preset};

        await this.declareScreenSize(preset, previous);
    }

    /**
     * Re-declare a running share's size, for the change that did not republish.
     *
     * <p>Compared on what is <b>solved</b> rather than on what was asked for, in both directions. A
     * content-mode change retypes the encoder without moving a pixel, and a resolution change that
     * the source or the ceiling already bounded moves none either - declaring either would spend a
     * round trip restating the ceiling exactly where the last publish put it. Silence is not a claim
     * in either direction, so saying nothing is the correct answer for both.</p>
     */
    private async declareScreenSize(preset: StreamPreset, previous: StreamPreset): Promise<void> {
        const target = this.voiceTarget;
        if (!target) return;

        const height = this.solvedScreenHeight(preset);
        if (height === null) return;
        if (height === this.solvedScreenHeight(previous) && preset.framerate === previous.framerate) return;

        await firstValueFrom(this.guildVoiceSvc.declareVideo(target.guildId, target.channelId, {
            height,
            framerate: preset.framerate,
        })).catch(e => console.warn('[voice] could not declare the new share size', e));
    }

    /** What the running capture is solved to, or null when the source size is unknown. */
    private solvedScreenHeight(preset: StreamPreset): number | null {
        if (!this.screenSourceSize) return null;
        const {width, height} = this.screenSourceSize;
        const box = solveGeometry(width, height, preset.resolution, this.voiceLimits.videoCeiling());
        return box.height > 0 ? box.height : null;
    }

    // ── Volume / per-user audio controls ──────────────────────────────────────

    /**
     * The UI still owns the slider position, because Rust has no reason to remember it across a
     * rejoin. Rust owns what it *does*, which is a gain in the mixer.
     */
    setUserVolume(userId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.userVolumes.set(userId, clamped);
        void this.voiceEngine.setUserVolume(userId, clamped);
    }

    getUserVolume(userId: string): number {
        return this.userVolumes.get(userId) ?? 1;
    }

    /**
     * Set one participant's *stream* volume, independent of their voice - the gap Discord parity
     * task 6 closes. Mirrors {@link setUserVolume} exactly, applied to the share's mixer source
     * instead of the participant's.
     *
     * <p>Mute is layered on top of this, not folded into it: if the stream is currently muted the
     * new level is only remembered, not applied, so it does not audibly un-mute the stream out from
     * under the user. {@link toggleScreenAudioMute} reads it back on unmute.</p>
     */
    setScreenVolume(userId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.screenVolumes.set(userId, clamped);
        if (this.screenAudioMutedSignal().has(userId)) return;
        const shareId = this.remoteScreenAudioIds.get(userId);
        if (shareId) void this.voiceEngine.setUserVolume(shareId, clamped);
    }

    getScreenVolume(userId: string): number {
        return this.screenVolumes.get(userId) ?? 1;
    }

    isScreenAudioMuted(userId: string): boolean {
        return this.screenAudioMutedSignal().has(userId);
    }

    /**
     * Mutes a *stream's* audio, not the streamer's voice.
     *
     * Those are separate sources in the mixer - `screen-audio-{shareId}` against the user id - which
     * is why this can key on the share rather than the person. Muting someone's stream while still
     * hearing them talk over it is the whole point.
     */
    toggleScreenAudioMute(userId: string): void {
        const willMute = !this.screenAudioMutedSignal().has(userId);
        const shareId = this.remoteScreenAudioIds.get(userId);
        // Unmuting restores whatever volume was set, not unity - mute must not clobber the stored
        // level. See getScreenVolume/setScreenVolume.
        if (shareId) void this.voiceEngine.setUserVolume(shareId, willMute ? 0 : this.getScreenVolume(userId));
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            willMute ? n.add(userId) : n.delete(userId);
            return n;
        });
    }

    toggleLocalScreenAudio(): void {
        const muted = !this.localScreenAudioMuted();
        // Nothing to disable on this side - the track lives in the publisher. There is no other
        // branch any more: every share is published there, on both hosts.
        if (!this.rustAudioTrackName) return;
        void this.rustMedia.setScreenAudioMuted(muted);
        this.localScreenAudioMuted.set(muted);
    }

    getVideoStream(userId: string): MediaStream | null {
        return this.videoStreamsSignal().get(userId) ?? null;
    }

    getScreenStream(userId: string): MediaStream | null {
        return this.screenStreamsSignal().get(userId) ?? null;
    }

    /** Declares every track published from this client closed, so peers drop them. */
    async closeAllTracks(guildId: string, channelId: string): Promise<void> {
        const trackNames = this.getActiveTrackNames();
        if (trackNames.length === 0) return;
        await firstValueFrom(this.guildVoiceSvc.unpublish(guildId, channelId, trackNames))
            .catch(() => {
            });
    }

    /** Updates stream/audio state when a remote participant's track is closed by the server. */
    handleRemoteTrackClosed(trackName: string, userId: string): void {
        // Released here so a republish of the same name resubscribes instead of being skipped.
        this.wantedVideo.delete(trackName);
        const described = describeTrack(trackName);

        if (described.kind === 'screenAudio') {
            // Drop the source, or a stopped stream keeps its slot in the mixer forever - silent,
            // but still popped and mixed on every frame.
            void this.dropSource(trackName);
            this.remoteScreenAudioIds.delete(userId);
            return;
        }

        this.applySubscriptions();
        if (described.kind === 'video') {
            this.videoStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        } else if (described.kind === 'screen') {
            this.screenStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        }
    }
}
