/**
 * The unified voice room contract, shared by guild channels and direct calls.
 *
 * <p>Both room kinds are one system server-side (`Echo.Voice`), and the only differences on the
 * wire are the event prefix (`guild.voice.` / `call.`), the room id field (`channelId` / `callId`)
 * and which kind-specific events exist. Everything in this file is deliberately kind-agnostic so
 * the two clients cannot drift apart the way the two backends did.</p>
 */

import {VoiceRoomLimitsDto} from '../dtos/response/entitlement.dto';

export type VoiceRoomKind = 'channel' | 'call';

/**
 * `Joined` means a session exists; `Publishing` means a session *and* a microphone track exist.
 *
 * <p>Only `Publishing` participants are pullable. A session id on its own is not an invitation to
 * subscribe, which is why the snapshot withholds the handles until this reads `Publishing`.</p>
 */
export type VoicePublishState = 'Joined' | 'Publishing';

/** One screen share. `trackNames` says which halves exist - video only, or video and audio. */
export interface VoiceShareSnapshot {
    shareId: string;
    trackNames: string[];
    /**
     * The session the share is published on, which is **not** the publisher's microphone session.
     *
     * <p>A desktop client publishes its screen from a second process, on its own Cloudflare session
     * opened as <i>secondary</i> precisely so it is never recorded as that participant's audio - see
     * `SessionRole` in `src-tauri/src/media/publisher/signalling.rs`. So one participant has two
     * session ids, and a share's tracks exist on only one of them.</p>
     *
     * <p>This field was on the wire from the start and undeclared here, which is not a cosmetic
     * omission: without it the only session id in reach is the microphone's, and pulling a share
     * from it names a track that session does not publish. The server answers
     * `409 staleSubscription, refetchSnapshot`, the refetch returns the same snapshot, and the pair
     * chase each other for as long as the viewer stays in the channel. Worse, on the audio half the
     * wrong id reads as a *corrected* announcement, so it unsubscribes a pull that was working.</p>
     *
     * <p>Null on a share the server stored before it recorded the session. That does not mean "use
     * the participant's" - it means the handle only ever arrived in `TrackPublished`, so a snapshot
     * cannot subscribe to that share and must leave whatever the live event set alone.</p>
     */
    mediaSessionId: string | null;
}

export interface VoiceParticipantSnapshot {
    userId: string;
    /** Null unless `publishState` is `Publishing`. */
    mediaSessionId: string | null;
    /** Null unless `publishState` is `Publishing`. */
    audioTrackName: string | null;
    publishState: VoicePublishState;
    isSelfMuted: boolean;
    isSelfDeafened: boolean;
    isServerMuted: boolean;
    isServerDeafened: boolean;
    isStreaming: boolean;
    shares: VoiceShareSnapshot[];
    joinedAt: string;
}

/**
 * The authoritative state of a room, and the only thing needed to be correct - whatever was
 * missed, whenever it is asked for.
 *
 * <p>Apply it wholesale. Merging it with what is already held defeats the point: the reason to ask
 * for a snapshot is that the local copy is known to be wrong.</p>
 */
export interface VoiceRoomSnapshot {
    roomId: string;
    kind: VoiceRoomKind;
    /** Null for calls. */
    guildId: string | null;
    instanceId: string;
    version: number;
    participants: VoiceParticipantSnapshot[];
    /**
     * What this room is allowed, and how much of it is in use.
     *
     * <p>Absent on a server that predates the contract and on a room whose limits have never been
     * computed, and both mean "no limit information" rather than "no limits" - see
     * {@link VoiceRoomLimitsDto}. What actually *bit* arrives separately, as `degradations[]` on the
     * join reply; this is what pre-empts, draws denominators and disables a control that would only
     * be refused.</p>
     */
    limits?: VoiceRoomLimitsDto;
    /**
     * What this client should be pulling, **nested**, and absent whenever no set is in force.
     *
     * <p>The optionality is the contract rather than tolerance for an old server: the snapshot omits
     * the block entirely unless the plan is selective, and an absent block means "pull everyone
     * `Publishing`" while a present one with no tracks means "pull nobody". Read it through
     * {@link subscriptionSetOfSnapshot} - design §8.1, §8.3.</p>
     */
    subscriptions?: VoiceSubscriptionSet;
}

/**
 * Every voice event carries these, added by the server's announcer rather than by the code that
 * raised the event - so no event can be emitted without them.
 */
export interface VoiceEventEnvelope {
    instanceId?: string;
    version?: number;
}

/**
 * `participantsEvicted` is the SFU having dropped participants out from under the room - their
 * publish state is wrong wholesale, so like the other three this is an instruction to refetch rather
 * than something that can be applied as a delta.
 */
export type VoiceResyncReason =
    'roomGone' | 'participantLeft' | 'peerPublishChanged' | 'participantsEvicted';

/** "Refetch, you are behind." Never carries a delta. */
export interface VoiceResyncEvent extends VoiceEventEnvelope {
    reason: VoiceResyncReason;
    /** Who the resync is about, on the two reasons that name someone. */
    userId?: string;
}

/**
 * What this client asserts about itself on every heartbeat.
 *
 * <p>Sent as the third argument of `voice.Heartbeat(roomKind, roomId, state)`. The server
 * reconciles in both directions from it: behind on version and a snapshot comes back; its record of
 * our media disagrees and it is corrected and re-announced to peers.</p>
 */
export interface VoiceHeartbeatState {
    knownInstanceId: string | null;
    knownVersion: number;
    /** The session we are publishing on, or null when not publishing. */
    mediaSessionId: string | null;
    /** The microphone track we have published, or null when not publishing. */
    audioTrackName: string | null;
}

// ── Subscriber state ─────────────────────────────────────────────────────────

/**
 * What one client asserts about its own rendering, sent to `POST .../voice/subscriptions`.
 *
 * <p>Every field is optional and an omitted one is left alone, so a tile resize is a body carrying
 * `tileHeights` and nothing else. Mirrors `Echo.Voice.Rooms.VoiceSubscriberUpdate`.</p>
 *
 * <p>Everything here can only ever <b>reduce</b> what this client is served, which is why it needs
 * no permission beyond being in the room: a client that lies costs itself media and costs nobody
 * else anything. Only `tileHeights` is populated today - see {@link VoiceSubscriberReportService} -
 * and the rest are declared because the wire contract carries them.</p>
 */
export interface VoiceSubscriberUpdate {
    /** This client is backgrounded or hidden. Drops video, never audio. */
    paused?: boolean;
    /** Publishers to keep subscribed whatever the ranking says. Capped server-side. */
    pinned?: string[];
    /** Publishers whose tile has been collapsed. Video only, same as {@link paused}. */
    pausedPublishers?: string[];
    /**
     * Publisher user id to the height, in **device pixels**, of the largest tile they are drawn in.
     *
     * <p>Replaced wholesale rather than merged, so a partial map silently un-reports whoever it
     * leaves out. This is the measurement that drives simulcast layer selection.</p>
     */
    tileHeights?: Record<string, number>;
    /** Share ids whose audio half is wanted. Screen-share audio is off by default. */
    screenAudioShares?: string[];
}

// ── Stale subscriptions ──────────────────────────────────────────────────────

/**
 * The server's word for "you subscribed to media nobody is publishing any more".
 *
 * Answered as `409 {"error":"staleSubscription","action":"refetchSnapshot"}` on `POST .../tracks`.
 * The Rust engine surfaces the same condition as an error string carrying this token, because
 * everything across the Tauri boundary is a plain string.
 */
export const STALE_SUBSCRIPTION = 'staleSubscription';

/**
 * Whether a failed subscribe means our view of the room is out of date.
 *
 * <p>Handles both shapes: an Angular `HttpErrorResponse` from the webview's own calls, and the
 * error string the Rust voice engine returns for subscribes it made on our behalf.</p>
 *
 * <p>This is the one failure that must **not** be retried. The track is gone rather than late, so
 * the identical body fails again for as long as the client keeps trying - which is exactly the loop
 * behind incident VNT-GE21R3P7, where one publisher who stopped a share without closing its tracks
 * produced four 502s a minute and put voice on the status page. The answer is to refetch the
 * snapshot and reconcile against it.</p>
 */
export function isStaleSubscription(error: unknown): boolean {
    if (typeof error === 'string') return error.includes(STALE_SUBSCRIPTION);

    const status = (error as {status?: number} | null)?.status;
    if (status !== 409) return false;

    // The body is where the reason lives; a 409 from somewhere else must not be swallowed as this.
    const body = (error as {error?: unknown} | null)?.error;
    if (typeof body === 'string') return body.includes(STALE_SUBSCRIPTION);
    return (body as {error?: string} | null)?.error === STALE_SUBSCRIPTION;
}

/**
 * The server's word for "your own media session has no live peer connection".
 *
 * Answered as `409 {"error":"sessionGone","action":"recreateSession"}`. The SFU's own
 * `session_error` is also matched: it is what leaks through as a 502 when the operation reaches the
 * transport before the server classifies it, and it is what this client was actually seeing in the
 * field.
 */
export const SESSION_GONE = 'sessionGone';
export const DEAD_MEDIA_SESSION = 'session_error';

/**
 * Whether a failed track operation means *our own* media session is gone, rather than the media we
 * asked for.
 *
 * <p>Distinct from {@link isStaleSubscription} in both direction and remedy. A stale subscription is
 * a track that has stopped: refetch the snapshot and pull whatever replaced it. This is the session
 * doing the pulling being dead, which no snapshot can repair - the session has to be rebuilt before
 * anything can be pulled onto it at all.</p>
 *
 * <p>It reaches us as a 502 whose body carries the SFU's own error verbatim, e.g.
 * `{"errorCode":"session_error","errorDescription":"Session appears to be disconnected. Please check
 * if the PeerConnection is connected."}`. Matched on the code rather than the description, which is
 * prose and not a contract.</p>
 */
export function isDeadMediaSession(error: unknown): boolean {
    if (typeof error === 'string') {
        return error.includes(SESSION_GONE) || error.includes(DEAD_MEDIA_SESSION);
    }

    const status = (error as {status?: number} | null)?.status;
    // Only these two. The status is checked as well as the code so that an unrelated failure whose
    // body happens to carry the word cannot be answered by tearing down a healthy session.
    if (status !== 409 && status !== 502) return false;

    const body = (error as {error?: unknown} | null)?.error;
    if (typeof body === 'string') {
        return body.includes(SESSION_GONE) || body.includes(DEAD_MEDIA_SESSION);
    }

    // The server's own shape: `{ error: "sessionGone", action: "recreateSession" }`.
    if ((body as {error?: string} | null)?.error === SESSION_GONE) return true;

    // The transport's, relayed: `{ operation, error }`, where `error` is the SFU's JSON as a string.
    const inner = (body as {error?: unknown} | null)?.error;
    return typeof inner === 'string' && inner.includes(DEAD_MEDIA_SESSION);
}

// ── Track naming ─────────────────────────────────────────────────────────────

export type VoiceTrackKind = 'audio' | 'video' | 'screen' | 'screenAudio';

export const MICROPHONE_TRACK = 'audio';
const SCREEN_PREFIX = 'screen-';
const SCREEN_AUDIO_PREFIX = 'screen-audio-';

export function screenTrackName(shareId: string): string {
    return SCREEN_PREFIX + shareId;
}

export function screenAudioTrackName(shareId: string): string {
    return SCREEN_AUDIO_PREFIX + shareId;
}

export interface VoiceTrackDescriptor {
    trackName: string;
    kind: VoiceTrackKind;
    /** The screen share this track belongs to, or null for microphone and camera tracks. */
    shareId: string | null;
}

/**
 * What a track name means. Mirrors `Echo.Voice.Tracks.TrackNaming.Describe` exactly, because the
 * name is the only thing the SFU stores and both ends have to read it the same way.
 *
 * <p>The ordering is load-bearing: `screen-audio-{id}` also satisfies `startsWith('screen-')`, so
 * the screen-audio test has to come first. Backwards, a share's audio reads as the video of a share
 * whose id is literally `audio-{id}`, and clients subscribe to a track that does not exist.</p>
 *
 * <p>Anything unrecognised is a camera rather than an error - an unknown name still has to be
 * relayed, and refusing to describe it would drop the publish silently.</p>
 */
export function describeTrack(trackName: string): VoiceTrackDescriptor {
    if (trackName.startsWith(SCREEN_AUDIO_PREFIX)) {
        return {trackName, kind: 'screenAudio', shareId: trackName.slice(SCREEN_AUDIO_PREFIX.length)};
    }
    if (trackName.startsWith(SCREEN_PREFIX)) {
        return {trackName, kind: 'screen', shareId: trackName.slice(SCREEN_PREFIX.length)};
    }
    if (trackName === MICROPHONE_TRACK) {
        return {trackName, kind: 'audio', shareId: null};
    }
    return {trackName, kind: 'video', shareId: null};
}

// ── Subscription sets ────────────────────────────────────────────────────────

/**
 * How the server chose what to serve this subscriber: `all` is every publisher in the room,
 * `activeSpeaker` a ranked subset that moves as people talk.
 *
 * <p>Informational. What is actually pulled is {@link VoiceSubscriptionSet.tracks} and nothing else,
 * which is why an unrecognised spelling here can safely fall back to `all` while an unrecognised
 * `tracks` can fall back to nothing at all.</p>
 */
export type VoiceSubscriptionMode = 'all' | 'activeSpeaker';

/**
 * The server's **ranking** vocabulary - `a` top, `b` middle, `c` bottom - and not a rid.
 *
 * <p>We publish rids named `f`/`h`/`q`; the server never sees one and never matches one, mapping rid
 * to quality through the `layers` list on the publish request. These letters are a separate
 * vocabulary that happens to be spelled the same way the old Cloudflare rids were, for an unrelated
 * reason. Map them onto `VideoQuality.HIGH`/`MEDIUM`/`LOW` - design §2.5, §6.1.</p>
 */
export type VoiceSubscriptionLayer = 'a' | 'b' | 'c';

/** One track this client is told to hold open. */
export interface VoiceSubscriptionTrack {
    /**
     * Who is publishing it. Sets are keyed by **user id**, never by LiveKit identity: there is no
     * way to address one connection of a user and no need for one, so the client splits the list by
     * {@link kind} and routes audio to the Rust room and video to the webview - design §6.2.
     */
    userId: string;
    mediaSessionId: string | null;
    trackName: string;
    kind: VoiceTrackKind;
    shareId: string | null;
    /**
     * Null on every audio entry unconditionally, and on video the server expresses no preference
     * about. That unconditional null is what makes reporting tile state from the webview safe even
     * though the same report governs audio: a collapsed tile stops paying for pixels, not sound.
     */
    layer: VoiceSubscriptionLayer | null;
}

/**
 * What one subscriber should be pulling right now.
 *
 * <p>Reached only through {@link subscriptionSetOf} and its two entry points, and that is the point:
 * the object exists <b>only</b> when a set is in force, so "no set" is the absence of the whole
 * object rather than an empty {@link tracks}. Declaring `tracks: VoiceSubscriptionTrack[]` on a type
 * that is always present would collapse the two and silently mute the room - design §8.3.</p>
 */
export interface VoiceSubscriptionSet {
    mode: VoiceSubscriptionMode;
    /**
     * Monotonic per subscriber, and **unrelated to the room `version`**. Two server instances can
     * announce out of order, so a set below one already applied is discarded - see
     * {@link subscriptionSetSupersedes}.
     */
    revision: number;
    activeSpeakers: string[];
    /**
     * Exactly what to pull - no more, and no less. An empty array here is a real instruction:
     * <i>pull nobody</i>, which is what every tile being collapsed looks like.
     */
    tracks: VoiceSubscriptionTrack[];
}

/**
 * `guild.voice.SubscriptionsChanged` / `call.SubscriptionsChanged`, which is **flat**.
 *
 * <p>The announcer puts the four inner fields straight onto the room-id/`instanceId`/`version`
 * envelope; there is no `subscriptions` key on the event, and the guide's event table saying
 * otherwise was wrong (design §8.1). Read it through {@link subscriptionSetOfEvent}, never through
 * {@link subscriptionSetOfSnapshot} - the wrong reach finds no `tracks` and means the opposite of
 * what arrived.</p>
 */
export interface VoiceSubscriptionsChangedEvent extends VoiceEventEnvelope {
    /** Set on a guild channel event. */
    channelId?: string;
    /** Set on a direct call event. */
    callId?: string;
    mode?: VoiceSubscriptionMode;
    revision?: number;
    activeSpeakers?: string[];
    /** Absent or null means no set is in force. `[]` means a real set that pulls nobody. */
    tracks?: VoiceSubscriptionTrack[] | null;
}

const SUBSCRIPTION_LAYERS: readonly string[] = ['a', 'b', 'c'];
const TRACK_KINDS: readonly string[] = ['audio', 'video', 'screen', 'screenAudio'];

/**
 * Read a subscription set out of the inner fields, wherever they were found.
 *
 * <p>Three surfaces carry the same four fields: the snapshot nests them under `subscriptions`, the
 * `SubscriptionsChanged` event flattens them onto the envelope, and `POST .../voice/subscriptions`
 * answers them as a bare `200` body. This is the one parser under all three; the two nesting shapes
 * are {@link subscriptionSetOfSnapshot} and {@link subscriptionSetOfEvent}.</p>
 *
 * <p><b>Null means "no set is in force", and is not the same answer as an empty set.</b> Design §8.3:
 * `tracks` absent or null means pull everyone `Publishing`, `tracks: []` means pull nobody. The
 * server shipped the second where it meant the first - a well-formed object with an empty array, in
 * every unplanned room, on every call - so a guard of "absent or non-object means leave the held set
 * alone" would not have saved anyone. Returning `null` rather than a set with no tracks is what keeps
 * the two readings apart past the parser, in the type and not only here.</p>
 */
export function subscriptionSetOf(raw: unknown): VoiceSubscriptionSet | null {
    if (raw === null || typeof raw !== 'object') return null;

    const block = raw as {
        mode?: unknown; revision?: unknown; activeSpeakers?: unknown; tracks?: unknown;
    };

    // The whole distinction, in one branch. Absent or null is "no set"; `[]` falls through as a set.
    if (!Array.isArray(block.tracks)) return null;

    return {
        mode: block.mode === 'activeSpeaker' ? 'activeSpeaker' : 'all',
        revision: typeof block.revision === 'number' ? block.revision : 0,
        activeSpeakers: Array.isArray(block.activeSpeakers)
            ? block.activeSpeakers.filter((id): id is string => typeof id === 'string')
            : [],
        tracks: block.tracks
            .map(subscriptionTrackOf)
            .filter((track): track is VoiceSubscriptionTrack => track !== null),
    };
}

/**
 * Whether an arriving set replaces the one already applied.
 *
 * <p>`revision` is the set's own counter and is **unrelated to the room `version`** - it does not
 * move when someone joins, and the room version does not move when a tile collapses. Two server
 * instances can announce a plan change at once, so a set below one already applied is a late
 * message and is dropped: applying it would resubscribe exactly what the newer one closed, and
 * nothing would correct it until the next change.</p>
 *
 * <p>Equality applies, for the same reason it does in {@link VoiceRoomTracker}: one plan change
 * reaches this client on more than one surface - the reply to `POST .../voice/subscriptions` and the
 * `SubscriptionsChanged` event - carrying one revision. A set is absolute rather than a delta, so
 * applying it twice is a no-op, while discarding the second costs a real change whenever the two
 * disagree.</p>
 */
export function subscriptionSetSupersedes(
    arriving: VoiceSubscriptionSet,
    held: {revision: number} | null,
): boolean {
    if (held === null) return true;
    return arriving.revision >= held.revision;
}

/**
 * The set a snapshot carries, which is **nested** under `subscriptions`.
 *
 * <p>Null when no set is in force, which on this surface is the whole key being absent. Takes
 * `unknown` rather than {@link VoiceRoomSnapshot} on purpose: it is reading the wire, and the thing
 * it most has to survive is being handed the wrong shape.</p>
 */
export function subscriptionSetOfSnapshot(snapshot: unknown): VoiceSubscriptionSet | null {
    if (snapshot === null || typeof snapshot !== 'object') return null;
    return subscriptionSetOf((snapshot as {subscriptions?: unknown}).subscriptions);
}

/**
 * The set a `SubscriptionsChanged` event carries, which is **flattened onto the envelope**.
 *
 * <p>The envelope's own `channelId`/`callId`/`instanceId`/`version` sit alongside the four inner
 * fields and are simply ignored here; the event's version is handled by
 * {@link VoiceRoomTracker.receiveRelay}, not by the set.</p>
 */
export function subscriptionSetOfEvent(event: unknown): VoiceSubscriptionSet | null {
    return subscriptionSetOf(event);
}

/**
 * One entry of `tracks[]`, or null for one that cannot be acted on.
 *
 * <p>`kind` and `shareId` are taken from the wire when they are spelled in a way this client knows,
 * and derived from the name with {@link describeTrack} otherwise - the name is the only thing the
 * SFU stores, and `describeTrack` mirrors the server's own `TrackNaming.Describe`, so the two agree
 * by construction. An entry naming no track or no publisher is dropped rather than kept, because it
 * can never be pulled and would otherwise sit in the diff being re-attempted forever.</p>
 */
function subscriptionTrackOf(raw: unknown): VoiceSubscriptionTrack | null {
    if (raw === null || typeof raw !== 'object') return null;

    const entry = raw as {
        userId?: unknown; mediaSessionId?: unknown; trackName?: unknown;
        kind?: unknown; shareId?: unknown; layer?: unknown;
    };
    const {userId, trackName} = entry;
    if (typeof userId !== 'string' || userId === '') return null;
    if (typeof trackName !== 'string' || trackName === '') return null;

    const described = describeTrack(trackName);
    const kind = typeof entry.kind === 'string' && TRACK_KINDS.includes(entry.kind)
        ? entry.kind as VoiceTrackKind
        : described.kind;
    const layer = typeof entry.layer === 'string' && SUBSCRIPTION_LAYERS.includes(entry.layer)
        ? entry.layer as VoiceSubscriptionLayer
        : null;

    return {
        userId,
        mediaSessionId: typeof entry.mediaSessionId === 'string' ? entry.mediaSessionId : null,
        trackName,
        kind,
        shareId: typeof entry.shareId === 'string' ? entry.shareId : described.shareId,
        layer,
    };
}

// ── Version tracking ─────────────────────────────────────────────────────────

/**
 * What to do with an event, given what is currently held.
 *
 * `refetch` means the local copy cannot be repaired from this event and the snapshot must be read
 * again.
 */
export type VoiceEventDecision = 'apply' | 'ignore' | 'refetch';

/**
 * Holds `instanceId` and `version` for one room and decides what each arriving event means.
 *
 * <p>This is the mechanism that makes voice recoverable. Without it a single dropped event leaves
 * the roster wrong until the session ends, which is the shape of every incident in this area: the
 * state was fine, the announcement was missed, and nothing ever repeated it.</p>
 *
 * <h4>The three subtleties</h4>
 *
 * <ul>
 *   <li><b>Equality applies.</b> One mutation can produce several events: publishing a screen share
 *   with audio bumps the version once and then emits one <code>TrackPublished</code> per track, all
 *   at that version. Treating equal versions as duplicates drops every track after the first, so a
 *   share with audio arrives silent. Handlers must therefore be idempotent - they are, since each
 *   sets a value or adds a track by name rather than incrementing anything.</li>
 *   <li><b>Relay events apply without advancing.</b> See {@link receiveRelay}.</li>
 *   <li><b>Snapshots and resyncs are not gated at all.</b> Both are handled by their callers rather
 *   than here - a resync is an instruction, and <code>roomGone</code> carries a blank instance and
 *   version zero precisely because there is no room left to describe.</li>
 * </ul>
 */
export class VoiceRoomTracker {
    private held: { instanceId: string; version: number } | null = null;

    /** The state to assert on the next heartbeat. Nulls before the first snapshot. */
    get instanceId(): string | null {
        return this.held?.instanceId ?? null;
    }

    get version(): number {
        return this.held?.version ?? 0;
    }

    /** True once a snapshot has been applied, so a heartbeat is worth sending. */
    get isTracking(): boolean {
        return this.held !== null;
    }

    /** Leaving a room. The next room starts from nothing rather than from a stranger's version. */
    reset(): void {
        this.held = null;
    }

    /** Take a snapshot wholesale. Never merge - see {@link VoiceRoomSnapshot}. */
    applySnapshot(snapshot: VoiceRoomSnapshot): void {
        this.held = {instanceId: snapshot.instanceId, version: snapshot.version};
    }

    /**
     * Classify a *relay* event - one the server does not store and does not bump the version for.
     *
     * <p>`SpeakingChanged`, `CameraChanged` and `SubscriptionsChanged` are pure relays: the server
     * loads the room rather than mutating it, so they arrive carrying whatever version is current.
     * That makes them useless as evidence of sequence, and actively dangerous as evidence of
     * *progress*.</p>
     *
     * <p>The failure it prevents: we hold v5, someone publishes (v6) and we miss it, then a
     * speaking relay arrives carrying v6. Advanced through {@link receive}, that reads as the next
     * event in sequence - so we absorb the version of a publish we never saw, and the real v7 that
     * follows looks perfectly contiguous. The missed publish is then permanent, which is the exact
     * class of bug the whole mechanism exists to remove.</p>
     *
     * <p>So a relay is applied and nothing is advanced. It cannot report a gap either, and that is
     * deliberate rather than a gap in coverage: speaking is written ten times a second, and putting
     * the recovery path behind it means a room we cannot resynchronise refetches at that rate.
     * Every other event detects the same gap at a sane one.</p>
     *
     * <p>`SubscriptionsChanged` is on this list for both halves of that reasoning. The subscription
     * set is recomputed from the room rather than stored on it, and it turns over as fast as people
     * take turns talking - so versioning it would make every sentence look like a missed roster
     * change, and advancing on it would let a plan recomputation stand in for a publish we never
     * saw. What ordering the set does need is its own: {@link subscriptionSetSupersedes}.</p>
     */
    receiveRelay(event: VoiceEventEnvelope): VoiceEventDecision {
        const {instanceId} = event;
        if (instanceId === undefined) return 'apply';
        if (this.held === null) return 'refetch';
        // A rebuilt room still invalidates everything held, relay or not.
        if (instanceId !== this.held.instanceId) return 'refetch';
        return 'apply';
    }

    /**
     * Classify an arriving state event.
     *
     * <p>Advances the held version as a side effect when the answer is `apply`, so a caller must
     * act on the result rather than calling this twice for one event. Relay events go through
     * {@link receiveRelay} instead.</p>
     */
    receive(event: VoiceEventEnvelope): VoiceEventDecision {
        const {instanceId, version} = event;

        // An event with no envelope predates the unified backend, or came from the guild presence
        // fan-out that has not migrated yet. Applying it is strictly better than dropping it: it
        // cannot tell us anything about being behind, but it still carries real state.
        if (instanceId === undefined || version === undefined) return 'apply';

        // Nothing held yet - the join snapshot has not landed. Read it rather than guessing.
        if (this.held === null) return 'refetch';

        // Checked before the version, and this order matters. A room that was destroyed and rebuilt
        // restarts its counter from zero, so it can climb back to a number already seen behind a
        // completely different roster. No version comparison can detect that.
        if (instanceId !== this.held.instanceId) return 'refetch';

        // Stale: an older event from another server instance arriving late. Equality is not stale -
        // see the class remarks.
        if (version < this.held.version) return 'ignore';

        // A gap. One refetch and we are correct again; without this branch a single dropped event
        // is permanent.
        if (version > this.held.version + 1) return 'refetch';

        this.held = {instanceId, version};
        return 'apply';
    }
}
