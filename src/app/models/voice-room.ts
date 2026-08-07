/**
 * The unified voice room contract, shared by guild channels and direct calls.
 *
 * <p>Both room kinds are one system server-side (`Echo.Voice`), and the only differences on the
 * wire are the event prefix (`guild.voice.` / `call.`), the room id field (`channelId` / `callId`)
 * and which kind-specific events exist. Everything in this file is deliberately kind-agnostic so
 * the two clients cannot drift apart the way the two backends did.</p>
 */

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
}

/**
 * Every voice event carries these, added by the server's announcer rather than by the code that
 * raised the event - so no event can be emitted without them.
 */
export interface VoiceEventEnvelope {
    instanceId?: string;
    version?: number;
}

export type VoiceResyncReason = 'roomGone' | 'participantLeft' | 'peerPublishChanged';

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
     * <p>`SpeakingChanged` and `CameraChanged` are pure relays: the server loads the room rather
     * than mutating it, so they arrive carrying whatever version is current. That makes them
     * useless as evidence of sequence, and actively dangerous as evidence of *progress*.</p>
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
