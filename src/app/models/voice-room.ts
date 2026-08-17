/** The unified voice room contract, shared by guild channels and direct calls. */

import {VoiceRoomLimitsDto} from '../dtos/response/entitlement.dto';

export type VoiceRoomKind = 'channel' | 'call';

/** `Joined` means a session exists; `Publishing` means a session and a microphone track exist. Only `Publishing` participants are pullable. */
export type VoicePublishState = 'Joined' | 'Publishing';

/** One screen share. `trackNames` says which halves exist: video only, or video and audio. */
export interface VoiceShareSnapshot {
    shareId: string;
    trackNames: string[];
    /**
     * The session the share is published on, which is never the publisher's microphone session.
     * Null means the handle is unknown; never fall back to the participant's session id.
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
    /** Published video that is not part of a screen share, in practice a camera. Absent means the server cannot report cameras, not that nobody has one. */
    videoTracks?: VoiceVideoTrackSnapshot[];
    joinedAt: string;
}

/** One camera track on the roster. A null `mediaSessionId` means the handle is unknown; never fall back to the microphone's session. */
export interface VoiceVideoTrackSnapshot {
    trackName: string;
    mediaSessionId: string | null;
}

/** The authoritative state of a room. Apply it wholesale; never merge it with what is already held. */
export interface VoiceRoomSnapshot {
    roomId: string;
    kind: VoiceRoomKind;
    /** Null for calls. */
    guildId: string | null;
    instanceId: string;
    version: number;
    participants: VoiceParticipantSnapshot[];
    /** What this room is allowed, and how much of it is in use. Absent means "no limit information", not "no limits". */
    limits?: VoiceRoomLimitsDto;
    /** What this client should be pulling, nested. Absent means "pull everyone `Publishing`"; present with no tracks means "pull nobody". */
    subscriptions?: VoiceSubscriptionSet;
}

/** Envelope fields the server's announcer adds to every voice event. */
export interface VoiceEventEnvelope {
    instanceId?: string;
    version?: number;
}

/** Why the server is telling this client to refetch. Every reason is an instruction, never a delta. */
export type VoiceResyncReason = 'roomGone' | 'participantLeft' | 'peerPublishChanged' | 'participantsEvicted';

/** "Refetch, you are behind." Never carries a delta. */
export interface VoiceResyncEvent extends VoiceEventEnvelope {
    reason: VoiceResyncReason;
    /** Who the resync is about, on the two reasons that name someone. */
    userId?: string;
}

/** What this client asserts about itself on every heartbeat, sent as the third argument of `voice.Heartbeat(roomKind, roomId, state)`. */
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
 * Every field is optional and an omitted one is left alone.
 */
export interface VoiceSubscriberUpdate {
    /** This client is backgrounded or hidden. Drops video, never audio. */
    paused?: boolean;
    /** Publishers to keep subscribed whatever the ranking says. Capped server-side. */
    pinned?: string[];
    /** Publishers whose tile has been collapsed. Video only, same as {@link paused}. */
    pausedPublishers?: string[];
    /** Publisher user id to the height, in device pixels, of the largest tile they are drawn in. Replaced wholesale, never merged. */
    tileHeights?: Record<string, number>;
    /** Share ids whose audio half is wanted. Screen-share audio is off by default. */
    screenAudioShares?: string[];
}

// ── Stale subscriptions ──────────────────────────────────────────────────────

/** The server's word for "you subscribed to media nobody is publishing any more". */
export const STALE_SUBSCRIPTION = 'staleSubscription';

/**
 * Whether a failed subscribe means our view of the room is out of date.
 * Must never be retried: refetch the snapshot and reconcile against it.
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

/** The server's word for "your own media session has no live peer connection". */
export const SESSION_GONE = 'sessionGone';
export const DEAD_MEDIA_SESSION = 'session_error';

/**
 * Whether a failed track operation means our own media session is gone, rather than the media we
 * asked for. The remedy is to rebuild the session; no snapshot can repair it.
 */
export function isDeadMediaSession(error: unknown): boolean {
    if (typeof error === 'string') {
        return error.includes(SESSION_GONE) || error.includes(DEAD_MEDIA_SESSION);
    }

    const status = (error as {status?: number} | null)?.status;
    // Only these two: the code alone must not tear down a healthy session.
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
 * What a track name means. Mirrors `Echo.Voice.Tracks.TrackNaming.Describe` exactly.
 * The branch order is load-bearing: the screen-audio test must come before the screen test.
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
 */
export type VoiceSubscriptionMode = 'all' | 'activeSpeaker';

/** The server's ranking vocabulary (`a` top, `b` middle, `c` bottom), not a rid. Maps onto `VideoQuality.HIGH`/`MEDIUM`/`LOW`. */
export type VoiceSubscriptionLayer = 'a' | 'b' | 'c';

/** One track this client is told to hold open. */
export interface VoiceSubscriptionTrack {
    /** Who is publishing it. Sets are keyed by user id, never by LiveKit identity. */
    userId: string;
    mediaSessionId: string | null;
    trackName: string;
    kind: VoiceTrackKind;
    shareId: string | null;
    /** Always null on audio entries, and on video the server expresses no preference about. */
    layer: VoiceSubscriptionLayer | null;
}

/** What one subscriber should be pulling right now. The object exists only when a set is in force. */
export interface VoiceSubscriptionSet {
    mode: VoiceSubscriptionMode;
    /** Monotonic per subscriber, and unrelated to the room `version`. */
    revision: number;
    activeSpeakers: string[];
    /** Exactly what to pull. An empty array is a real instruction: pull nobody. */
    tracks: VoiceSubscriptionTrack[];
}

/**
 * `guild.voice.SubscriptionsChanged` / `call.SubscriptionsChanged`, which is flat.
 * Read it through {@link subscriptionSetOfEvent}, never {@link subscriptionSetOfSnapshot}.
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
 * Null means "no set is in force", which is not the same answer as an empty set.
 */
export function subscriptionSetOf(raw: unknown): VoiceSubscriptionSet | null {
    if (raw === null || typeof raw !== 'object') return null;

    const block = raw as {
        mode?: unknown;
        revision?: unknown;
        activeSpeakers?: unknown;
        tracks?: unknown;
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
 * Equal revisions apply: one plan change reaches this client on more than one surface.
 */
export function subscriptionSetSupersedes(
    arriving: VoiceSubscriptionSet,
    held: {revision: number} | null,
): boolean {
    if (held === null) return true;
    return arriving.revision >= held.revision;
}

/** The set a snapshot carries, nested under `subscriptions`. Null when no set is in force. */
export function subscriptionSetOfSnapshot(snapshot: unknown): VoiceSubscriptionSet | null {
    if (snapshot === null || typeof snapshot !== 'object') return null;
    return subscriptionSetOf((snapshot as {subscriptions?: unknown}).subscriptions);
}

/** The set a `SubscriptionsChanged` event carries, flattened onto the envelope. */
export function subscriptionSetOfEvent(event: unknown): VoiceSubscriptionSet | null {
    return subscriptionSetOf(event);
}

/** One entry of `tracks[]`, or null for one that cannot be acted on. */
function subscriptionTrackOf(raw: unknown): VoiceSubscriptionTrack | null {
    if (raw === null || typeof raw !== 'object') return null;

    const entry = raw as {
        userId?: unknown;
        mediaSessionId?: unknown;
        trackName?: unknown;
        kind?: unknown;
        shareId?: unknown;
        layer?: unknown;
    };
    const {userId, trackName} = entry;
    if (typeof userId !== 'string' || userId === '') return null;
    if (typeof trackName !== 'string' || trackName === '') return null;

    const described = describeTrack(trackName);
    const kind =
        typeof entry.kind === 'string' && TRACK_KINDS.includes(entry.kind)
            ? (entry.kind as VoiceTrackKind)
            : described.kind;
    const layer =
        typeof entry.layer === 'string' && SUBSCRIPTION_LAYERS.includes(entry.layer)
            ? (entry.layer as VoiceSubscriptionLayer)
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

/** What to do with an event, given what is currently held. `refetch` means the snapshot must be read again. */
export type VoiceEventDecision = 'apply' | 'ignore' | 'refetch';

/**
 * Holds `instanceId` and `version` for one room and decides what each arriving event means.
 * Equal versions apply rather than being dropped, so handlers must be idempotent.
 */
export class VoiceRoomTracker {
    private held: {instanceId: string; version: number} | null = null;

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

    /** Take a snapshot wholesale. Never merge; see {@link VoiceRoomSnapshot}. */
    applySnapshot(snapshot: VoiceRoomSnapshot): void {
        this.held = {instanceId: snapshot.instanceId, version: snapshot.version};
    }

    /**
     * Classify a relay event, one the server does not store and does not bump the version for.
     * A relay is applied and the held version is never advanced from it.
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
     * Classify an arriving state event. Advances the held version as a side effect on `apply`, so
     * never call this twice for one event.
     */
    receive(event: VoiceEventEnvelope): VoiceEventDecision {
        const {instanceId, version} = event;

        // An event with no envelope carries real state but cannot report being behind.
        if (instanceId === undefined || version === undefined) return 'apply';

        // Nothing held yet: the join snapshot has not landed.
        if (this.held === null) return 'refetch';

        // Checked before the version: a rebuilt room restarts its counter from zero.
        if (instanceId !== this.held.instanceId) return 'refetch';

        // Stale: an older event from another server instance arriving late. Equality is not stale.
        if (version < this.held.version) return 'ignore';

        // A gap.
        if (version > this.held.version + 1) return 'refetch';

        this.held = {instanceId, version};
        return 'apply';
    }
}
