import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {firstValueFrom, Subscription} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {OAuthService} from 'angular-oauth2-oidc';
import {ConnectionState as LiveKitConnectionState} from 'livekit-client';
import {describeEntitlementDenial} from '../core/entitlement-message';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {VoiceEngineService, VoiceSession, VoiceTarget} from './voice-engine.service';
import {CallSessionService} from './call-session.service';
import {VoiceService} from './voice.service';
import {LiveKitRoomService, RemoteMediaTrack} from './livekit-room.service';
import type {RoomPublishing} from './voice-rtc.service';
import {
    callStatusName,
    ConnectionState,
    describeCallEndedReason,
    VoiceWebsocketService,
} from './voice-websocket.service';
import {ToastService} from './toast.service';
import {RustMediaService} from './rust-media.service';
import type {CallDto} from '../dtos/response/call.dto';
import {
    describeTrack,
    screenTrackName,
    VoiceEventDecision,
    VoiceEventEnvelope,
    VoiceRoomSnapshot,
    VoiceRoomTracker,
} from '../models/voice-room';
import type {VideoPublishIntentDto} from '../dtos/response/entitlement.dto';
import {inboundScreenFpsByShare, InboundTrackOwner} from '../shared/call/inbound-fps';
import {inboundStatsFor, kbpsBetween} from '../shared/call/stream-stats';
import type {StatsLike, StreamStatsSample, StreamStatsSnapshot} from '../shared/call/stream-stats';

export interface CallStats {
    inboundKbps: number;
    outboundKbps: number;
    inboundAudioKbps: number;
    inboundVideoKbps: number;
    outboundAudioKbps: number;
    outboundVideoKbps: number;
    packetsLost: number;
}

/**
 * How long to wait for this call's Rust publication before giving up on a subscribe.
 *
 * <p>The server announces every publisher the moment a room is joined, and those announcements land
 * while `voiceEngine.start()` is still pending - so an unwaited subscribe is dropped for every
 * participant who was already in the call. Exponential and starting at a second, so a cold connect
 * on a slow link is covered without a stampede.</p>
 *
 * <p>Declared here rather than imported from `voice-rtc.service.ts`, which is where it used to live:
 * that constant was part of the subscribe-retry apparatus the LiveKit migration deleted, and this is
 * a different schedule that happens to have the same shape. Exported so the wait is asserted rather
 * than described.</p>
 */
export const SESSION_WAIT_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * What a video publish is about to send, read off the track the device actually opened.
 *
 * <p>The settings rather than the constraint: a camera negotiates its own size, so asking for 720p
 * and being handed 1080p is ordinary, and stating the request would have the server clamp against a
 * resolution nothing is sending. Undefined when either half is unknown, which omits the field
 * entirely - a clamp the server cannot compute beats one computed from a number we made up.</p>
 */
export function videoIntentOf(track: MediaStreamTrack): VideoPublishIntentDto | undefined {
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
    const height = settings?.height;
    const framerate = settings?.frameRate;
    if (!height || height <= 0 || !framerate || framerate <= 0) return undefined;
    return {height, framerate: Math.round(framerate)};
}

/**
 * The detailed inbound snapshot for one inspected share.
 *
 * <p>Keyed by share, not user, because `onScreenShareStarted` dedupes by `shareId` alone and a
 * stale share can briefly sit in the model beside its replacement under the same user - the
 * identical reasoning as `inboundScreenFpsByShare`, see `inbound-fps.ts`.</p>
 *
 * <p>Exported and free-standing so it can be tested without a room: the service's own poll is a
 * two-line wrapper around it. The map is still keyed by mid, which is now read off each subscribed
 * receiver's own report rather than off a transceiver this service owns - see {@link
 * CallWebRtcService.inboundReport}.</p>
 */
export function detailedStatsForShare(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
    shareId: string | null,
): StreamStatsSample | null {
    if (!shareId) return null;
    for (const [mid, owner] of tracks) {
        if (owner.kind === 'screen' && owner.shareId === shareId) return inboundStatsFor(report, mid);
    }
    return null;
}

/** One remote video track the roster says this room should be holding open. */
interface WantedVideo {
    userId: string;
    kind: 'video' | 'screen';
    shareId: string | null;
}

/**
 * How the SDK's connection state reads to a call panel that still speaks `RTCPeerConnectionState`.
 *
 * <p>`Disconnected` maps to `'new'` rather than to `'disconnected'` on purpose: it is also the state
 * before a connect has landed, and {@link CallWebRtcService.rtcState} lets the Rust engine speak for
 * that case. Both reconnecting states are `'connecting'` - the distinction between resuming the
 * signal socket and resuming the whole session is the SDK's business, not the user's.</p>
 */
const RTC_STATE_BY_CONNECTION: Record<LiveKitConnectionState, RTCPeerConnectionState> = {
    [LiveKitConnectionState.Disconnected]: 'new',
    [LiveKitConnectionState.Connecting]: 'connecting',
    [LiveKitConnectionState.Connected]: 'connected',
    [LiveKitConnectionState.Reconnecting]: 'connecting',
    [LiveKitConnectionState.SignalReconnecting]: 'connecting',
};

/**
 * Everything about a DM call that is not negotiation.
 *
 * <p>Roster state, the ring lifecycle, event gating, snapshot backfill, the heartbeat, share-watch,
 * per-source volumes and the statistics the diagnostics panel reads. `CallSessionService` owns the
 * UI state; this owns what the room is doing.</p>
 *
 * <p><b>Two transports, and the split is not negotiable.</b> The Rust room holds this user's primary
 * identity and every audio track in the call - microphones and `screen-audio-*`, both of which feed
 * the mixer where AEC and per-source volume live. This service drives a *secondary* connection
 * tagged `view` that carries video only. A webview that also pulled audio would play the room twice,
 * and the second copy is not muteable from any control the user can see.</p>
 */
@Injectable({providedIn: 'root'})
export class CallWebRtcService {
    // ── Stats polling ────────────────────────────────────────────────────────
    readonly stats = signal<CallStats | null>(null);
    /**
     * Remote screen shares' arriving frame rate, by share id - see `inboundScreenFpsByShare` for how
     * this is read off the same reports {@link stats} comes from, and `CallScreenShare.inboundFps`
     * for why a share missing from this map must render as "no data" rather than 0.
     *
     * <p>Keyed by share id, not user id: `CallSessionService.onScreenShareStarted` dedupes incoming
     * shares by `shareId` alone, so a stale share can briefly sit in the model alongside its
     * replacement under the same `userId` (a rapid stop/restart race). Keying this by user would
     * make one of the two silently report the other's number.</p>
     */
    private readonly inboundVideoFpsByShareSignal = signal<Record<string, number>>({});
    readonly inboundVideoFpsByShare = this.inboundVideoFpsByShareSignal.asReadonly();
    /** See the twin on `VoiceRTCService`. This service uses `shareId` and ignores `userId`. */
    readonly inspected = signal<{shareId: string; userId: string} | null>(null);
    readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);

    /**
     * The previous poll's cumulative `bytesReceived`, per layer, and when it was taken.
     *
     * <p>The twin of the state on `VoiceRTCService`, and there for the same reason:
     * `inboundStatsFor` sees one report and a rate needs two samples, so the differentiation
     * belongs to whoever owns the poll. Cleared in {@link stopStatsPolling} so a reopened panel
     * starts from a fresh baseline rather than spiking off a counter from the previous call.</p>
     */
    private prevInboundBytes = new Map<string, number>();
    private prevInboundAt = 0;

    // ── Connection state ──────────────────────────────────────────────────────
    private readonly engineUp = signal(false);
    private livekit = inject(LiveKitRoomService);

    /**
     * What the call UI shows as the connection state.
     *
     * <p>This room only receives, so until somebody publishes video there is nothing for it to do
     * and the SDK sits short of `Connected` - which the call panel would read as "connecting" and
     * never leave. Whether your voice is going out is the Rust engine's business; once the room has
     * something to do, its own state takes over again, including its failures.</p>
     */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const state = RTC_STATE_BY_CONNECTION[this.livekit.state()] ?? 'new';
        return state === 'new' && this.engineUp() ? 'connected' : state;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    private callSession = inject(CallSessionService);

    /**
     * What the token this client connected with actually grants.
     *
     * <p>The microphone and camera buttons render from these rather than from locally computed
     * permission. The rights are decided when the token is minted and enforced by the node, so a
     * member whose plan has no video left connects, hears everyone, and cannot turn a camera on
     * however the client is patched - a button drawn from our own arithmetic would do nothing.</p>
     */
    private readonly canPublishAudioSignal = signal(true);
    readonly canPublishAudio = this.canPublishAudioSignal.asReadonly();
    private readonly canPublishVideoSignal = signal(true);
    readonly canPublishVideo = this.canPublishVideoSignal.asReadonly();

    /**
     * Narrow views of the session, so effects wake on the value they care about rather than on
     * every rebuild of the session object. A `computed` over a boolean only notifies when the
     * boolean actually flips.
     */
    private readonly localMuted = computed(() => this.callSession.session()?.local.isMuted ?? false);
    private readonly localDeafened = computed(() => this.callSession.session()?.local.isDeafened ?? false);
    private voiceService = inject(VoiceService);
    private voiceWs = inject(VoiceWebsocketService);
    private rustMedia = inject(RustMediaService);
    private voiceEngine = inject(VoiceEngineService);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private oauth = inject(OAuthService);

    // ── Room state ───────────────────────────────────────────────────────────
    private callId: string | null = null;
    /**
     * The Rust publication carrying this call's audio.
     *
     * Held rather than looked up, because the engine now runs several calls at once and every
     * command has to say which one it means. Isle proximity voice holds its own alongside this.
     */
    private voiceSession: VoiceSession | null = null;

    // ── Local publications ───────────────────────────────────────────────────
    private localVideoTrack: MediaStreamTrack | null = null;
    private localScreenTrack: MediaStreamTrack | null = null;
    private screenShareId: string | null = null;

    // Users already subscribed to for audio - makes subscribeToTrack('audio') safe to call more than
    // once for the same user (the live ParticipantJoined event and a reconcile-on-reconnect backfill
    // can race for the same user).
    private readonly subscribedAudioUserIds = new Set<string>();
    // userId → the mixer source id of their share's audio, so the per-stream mute can find it.
    //
    // Keyed by *track name* rather than user id in the mixer, because a share's audio and its
    // author's voice are separate sources - muting the stream must not mute the person sharing it.
    private readonly remoteScreenAudioIds = new Map<string, string>();
    private readonly screenAudioMutedSignal = signal<Set<string>>(new Set());
    readonly screenAudioMuted = this.screenAudioMutedSignal.asReadonly();

    /**
     * What the roster says this room should be pulling, by track name.
     *
     * <p>The demand, not the holding: {@link reconcileVideo} diffs it against what the SDK reports
     * and moves one subscription per difference. Names rather than sids, because the roster and
     * every event about it speak the track naming convention and know nothing of the SFU's ids.</p>
     */
    private readonly wantedVideo = new Map<string, WantedVideo>();
    /** What has actually been handed to the UI, so a departure can be told from a late arrival. */
    private readonly attachedVideo = new Map<string, WantedVideo>();

    /**
     * Roster rows this room could not turn into a subscription, because the SFU has not announced
     * the publication yet.
     *
     * <p>Ordinary and self-correcting - SignalR and the SDK race, and the next reconcile retries -
     * but counted rather than silent, because a room that pulls nothing looks exactly like a room
     * nobody is publishing to.</p>
     */
    private readonly unresolvedVideoSignal = signal(0);
    readonly unresolvedVideo = this.unresolvedVideoSignal.asReadonly();
    /** Said once per session rather than per call - see {@link RoomPublishing}. */
    private warnedMissingRoomSurface = false;

    /**
     * `instanceId` and `version` for this call, and the decision procedure for every event about
     * it. See {@link VoiceRoomTracker}.
     */
    private readonly tracker = new VoiceRoomTracker();
    private refetchInFlight = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private prevConnState: ConnectionState | null = null;
    // Per-user volume overrides (0-1.0), persisted for the call duration
    private readonly userVolumes = new Map<string, number>();
    // Per-share volume overrides (0-1.0), persisted for the call duration.
    //
    // Deliberately its own map rather than reusing userVolumes: a stream's audio is a different
    // mixer source than its author's voice (see remoteScreenAudioIds), and the two have to be
    // adjustable independently - the same reason mute is keyed on the track rather than the user.
    private readonly screenVolumes = new Map<string, number>();

    // ── Prev-state for change detection inside effects ───────────────────────
    private prevMuted = false;
    private prevCameraOn = false;
    private prevSharing = false;
    // ── RxJS subscriptions to WS observables ────────────────────────────────
    private wsSubs: Subscription[] = [];
    private statsInterval?: ReturnType<typeof setInterval>;
    private prevBytes = {inAudio: 0, inVideo: 0};
    private prevStatsTs = 0;

    constructor() {
        // CallSessionService owns the preset (it also drives capture); re-declare what is being sent
        // whenever the user changes quality mid-share. The publication is unchanged - only its size
        // is - and `PUT .../video` is the only thing that tells the server about that.
        effect(() => {
            const preset = this.callSession.screenPreset();
            if (preset && this.localScreenTrack) void this.redeclareVideo(this.localScreenTrack);
        });

        // Connect when a session starts; disconnect when it ends.
        effect(() => {
            const s = this.callSession.session();
            if (s && !this.callId) {
                void this.connect(s.callId);
            } else if (!s && this.callId) {
                this.disconnect();
            }
        });

        // Everything the room hands us, reconciled against what the roster asked for. Driven from a
        // signal rather than from a callback so a track that arrives before its roster row - which
        // is ordinary, the SFU is faster than SignalR - is picked up by the next pass rather than
        // dropped on the floor.
        effect(() => {
            const tracks = this.livekit.remoteTracks();
            untracked(() => this.reconcileVideo(tracks));
        });

        // A reconnect is the signal that any `call.*` events broadcast during the gap were dropped -
        // SignalR doesn't queue undelivered messages. Re-sync authoritative state so a missed
        // ParticipantJoined/CallEnded doesn't leave us permanently out of sync.
        effect(() => {
            const cs = this.voiceWs.connectionState();
            const wasConnected = this.prevConnState === ConnectionState.Connected;
            this.prevConnState = cs;
            if (cs === ConnectionState.Connected && !wasConnected && this.callId) {
                // Asserted immediately rather than at the next tick of the 30-second timer. A
                // disconnect shortens our liveness window server-side, and the heartbeat is what
                // restores it - and what pulls back a Snapshot if we fell behind while away.
                //
                // Nothing here rebuilds media. The room and the Rust publication ride their own
                // transport and a hub blip says nothing about them.
                this.sendHeartbeat();
                void this.syncParticipants();
            }
        });

        // Apply local mute state + push-to-talk gate. Only the deliberate mute toggle is broadcast
        // to peers - the PTT gate is a purely local transmit gate, same as Isle proximity's syncMic.
        //
        // Both go to the Rust engine as separate facts. They used to be collapsed into one
        // `track.enabled`, which forced this effect to tiptoe around the voice-activity gate that
        // was fighting it for the same boolean; there is now exactly one gate and it lives with the
        // audio it gates.
        // Reads `localMuted`, not `session()`. Tracking the whole session object woke this on every
        // participant, speaking and camera change, and each wake fired two IPC calls into Rust.
        effect(() => {
            const isMuted = this.localMuted();
            // Mute is engine-wide - one microphone. The talk key is per call, so it names this
            // call's publication and cannot also open Isle proximity voice.
            void this.voiceEngine.setMute(isMuted);
            this.setPttOpen(this.callSession.pttGateOpen());
            if (isMuted === this.prevMuted) return;
            this.prevMuted = isMuted;
            if (this.callId) this.voiceWs.invokeMuteChange(this.callId, isMuted);
        });

        // Own speaking state, straight from the Rust gate - the same decision that picks which
        // frames are transmitted, so the indicator cannot disagree with what is actually sent.
        //
        // The session read is untracked deliberately. This effect *writes* to the session via
        // onSpeakingChanged, so tracking it would make the effect retrigger itself - an infinite
        // loop allocating a session object per pass. `speaking()` is the only thing that should
        // wake it.
        effect(() => {
            const speaking = this.voiceEngine.speaking();
            const localId = untracked(() =>
                this.callSession.session()?.participants.find(p => p.isLocal)?.userId);
            if (localId) this.callSession.onSpeakingChanged(localId, speaking);
        });

        // Apply local deafen state in the mixer that owns playout - mirrors VoiceRTCService for the
        // guild path. Narrowed to `localDeafened` for the same reason as the mute effect above.
        effect(() => {
            void this.voiceEngine.setDeafened(this.localDeafened());
        });

        // Publish or unpublish the local camera track when the user toggles it.
        effect(() => {
            const s = this.callSession.session();
            if (!s) return;
            const isCameraOn = s.local.isCameraOn;
            if (isCameraOn === this.prevCameraOn) return;
            this.prevCameraOn = isCameraOn;
            if (isCameraOn) {
                const localP = s.participants.find(p => p.isLocal);
                if (localP?.videoStream) void this.publishVideoTrack(localP.videoStream);
            } else {
                void this.unpublishVideoTrack();
            }
        });

        // Publish or unpublish the screen share track. Unlike the guild path, a DM share has always
        // been published from the webview rather than from the Rust publisher.
        effect(() => {
            const s = this.callSession.session();
            if (!s) return;
            const isSharing = s.local.isSharing;
            if (isSharing === this.prevSharing) return;
            this.prevSharing = isSharing;
            if (isSharing) {
                const localShare = s.screenShares.find(sh => sh.isLocal);
                if (localShare?.stream) void this.publishScreenTrack(localShare.shareId, localShare.stream);
            } else {
                void this.unpublishScreenTrack();
            }
        });

        // Re-arms the poll when a stats panel opens or closes. Runs only when the connection is
        // already polling; there is nothing to re-arm otherwise.
        effect(() => {
            this.inspected();
            if (this.statsInterval !== undefined) this.armStatsInterval();
        });
    }

    // ── Per-source volume ─────────────────────────────────────────────────────

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
        const sourceId = this.remoteScreenAudioIds.get(userId);
        if (sourceId) void this.voiceEngine.setUserVolume(sourceId, clamped);
    }

    getScreenVolume(userId: string): number {
        return this.screenVolumes.get(userId) ?? 1;
    }

    /** Whether this participant's shared stream is muted locally. */
    isScreenAudioMuted(userId: string): boolean {
        return this.screenAudioMutedSignal().has(userId);
    }

    /**
     * Mute or unmute one participant's shared stream, leaving their voice alone.
     *
     * <p>Remembered even when there is no live source: the flag survives the share stopping and
     * restarting, so a user who muted a noisy stream does not have to mute it again every time the
     * sharer changes resolution.</p>
     */
    toggleScreenAudioMute(userId: string): void {
        const willMute = !this.screenAudioMutedSignal().has(userId);
        const sourceId = this.remoteScreenAudioIds.get(userId);
        // Unmuting restores whatever volume was set, not unity - mute must not clobber the stored
        // level. See getScreenVolume/setScreenVolume.
        if (sourceId) void this.voiceEngine.setUserVolume(sourceId, willMute ? 0 : this.getScreenVolume(userId));
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            if (willMute) n.add(userId);
            else n.delete(userId);
            return n;
        });
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────

    /**
     * Open this call's room.
     *
     * <p>Driven from an effect as `void this.connect(...)`, so nothing is holding the promise and a
     * rejection here has no call site to land at. It used to be unguarded: a refused connection -
     * offline SFU, a revoked call, an entitlement rejection - surfaced as an unhandled rejection in
     * the console and left `callId` set, which blocks every later attempt because that field is the
     * re-entry guard. The catch tears the half-built connection down so the next attempt can run,
     * and says something, because a call that is silently not connected looks exactly like one that
     * is.</p>
     */
    private async connect(callId: string): Promise<void> {
        this.callId = callId; // Set immediately so re-entry is prevented

        try {
            await this.openSession(callId);
        } catch (err) {
            console.error('[call] room setup failed', err);
            this.disconnect();
            const denial = describeEntitlementDenial(err);
            this.toast.error(this.translate.instant(denial?.messageKey ?? 'CALL.CONNECT_FAILED'));
        }
    }

    private async openSession(callId: string): Promise<void> {
        // Two connections, and they have to be two.
        //
        // The Rust room takes the **primary** and with it this user's bare identity - that is the
        // connection the roster records as the participant, and the one the microphone publishes
        // on. This room takes a **secondary** tagged `view`, so `{userId}#view`. Handing one
        // connection to both would put two clients on one identity, and the SFU disconnects the
        // earlier session under a duplicate: the client would kick its own call off the air. One tag
        // per connection per user, so `view` is never reused for a second webview room either.
        //
        // Minting two is cheap and safe - `POST .../voice/connection` makes no roster write and
        // re-announces nobody - which is also why neither may be cached against the call id.
        const [primary, view] = await Promise.all([
            firstValueFrom(this.voiceService.connection(callId, true)),
            firstValueFrom(this.voiceService.connection(callId, false, 'view')),
        ]);
        if (this.callId !== callId) return;

        // Each grant read off the connection that would exercise it: the microphone publishes on the
        // primary, the camera and the share on this one. They agree today - the rights are a fact
        // about the user and the room, not about the connection - and reading them apart is what
        // keeps that an observation rather than an assumption.
        this.canPublishAudioSignal.set(primary.canPublishAudio);
        this.canPublishVideoSignal.set(view.canPublishVideo);

        await this.livekit.connect({url: view.url, token: view.token});
        if (this.callId !== callId) {
            void this.livekit.disconnect();
            return;
        }

        // Set up WS listeners NOW - we need to be subscribed before the Rust room's publish puts us
        // on the roster, which is what makes the server re-announce every already-connected
        // participant back to us.
        this.setupWsListeners();

        // Backfill in case that re-announce is ever missed (e.g. joining a group call already in
        // progress right as a signalling gap opens) - every subscribe path is idempotent, which is
        // what makes this safe to race with the WS listener.
        void this.syncParticipants();

        // The microphone is captured, processed and published entirely in Rust, on the primary
        // connection fetched above. Nothing is published here; the other side resolves the track
        // from the roster.
        //
        // The connection travels down rather than being fetched in Rust, because the webview has the
        // interceptor chain: it refreshes an expired bearer and replays, and a token string captured
        // once in a native process cannot. Absent, Rust falls back to the Cloudflare path and the
        // microphone would 404 against a route that no longer exists.
        try {
            this.voiceSession = await this.startEngine(
                {kind: 'call', callId},
                await this.deviceIdentity.deviceId(),
                {url: primary.url, token: primary.token},
            );
        } catch (e) {
            console.error('[call] Rust voice engine failed to start - joining without audio', e);
            return;
        }
        if (!this.callId) {
            void this.voiceEngine.stop(this.voiceSession);
            this.voiceSession = null;
            return;
        }
        this.engineUp.set(true);

        // Apply current mute state immediately - the user may have muted before connecting, and the
        // engine starts with its talk key up, which in push-to-talk mode means the gate is shut.
        const isMuted = this.callSession.session()?.local.isMuted ?? false;
        this.prevMuted = isMuted;
        void this.voiceEngine.setMute(isMuted);
        this.setPttOpen(this.callSession.pttGateOpen());

        // Read the room again now that there is something to subscribe *on*. The snapshot pushed at
        // join arrives before the room and the Rust session exist, so its screen shares would
        // otherwise be dropped on the floor - the same ordering trap the guild path has.
        void this.refetchSnapshot();

        // Liveness *and* repair: this is what lets the server correct its record of what we are
        // publishing and re-announce it to peers.
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30_000);

        this.startStatsPolling();
    }

    private disconnect(): void {
        this.stopStatsPolling();
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        // The next call starts from nothing. Two rooms have unrelated counters, and carrying one
        // across would make the first event of the new call read as a gap or as stale depending on
        // which way the numbers happened to fall.
        this.tracker.reset();
        // Only this call. Isle proximity voice may be running on the same microphone and must
        // survive hanging up.
        if (this.voiceSession) void this.voiceEngine.stop(this.voiceSession);
        this.voiceSession = null;
        this.engineUp.set(false);
        void this.rustMedia.stopScreenCapture();
        void this.livekit.disconnect();
        this.wsSubs.forEach(s => s.unsubscribe());

        this.participantsWithAudio.set(new Set());
        this.callId = null;
        this.localVideoTrack = null;
        this.localScreenTrack = null;
        this.screenShareId = null;
        this.canPublishAudioSignal.set(true);
        this.canPublishVideoSignal.set(true);
        this.wantedVideo.clear();
        this.attachedVideo.clear();
        this.unresolvedVideoSignal.set(0);
        this.userVolumes.clear();
        this.screenVolumes.clear();
        this.subscribedAudioUserIds.clear();
        this.remoteScreenAudioIds.clear();
        this.screenAudioMutedSignal.set(new Set());
        this.wsSubs = [];
        this.prevMuted = false;
        this.prevCameraOn = false;
        this.prevSharing = false;
    }

    /**
     * Start the microphone on the primary connection this client just fetched.
     *
     * <p><b>The cast is a seam, not a shortcut.</b> `VoiceStartOptions.livekit` exists and the Tauri
     * adapter forwards it to Rust, but `VoiceEngineService.start` still takes four arguments and
     * drops the fifth - and that file is not this one's to change. Passed anyway and pinned by a
     * test, so the day the engine grows the parameter this works with the `as` removed and nothing
     * else moved. Until then the microphone falls back to the route Rust takes when no connection is
     * given, which is the Cloudflare one, and it 404s. Twin of `VoiceRTCService.startEngine`.</p>
     */
    private startEngine(
        target: VoiceTarget,
        deviceId: string,
        livekit: {url: string; token: string},
    ): Promise<VoiceSession> {
        const start = this.voiceEngine.start as unknown as (
            target: VoiceTarget, apiBase: string, token: string, deviceId: string,
            livekit: {url: string; token: string},
        ) => Promise<VoiceSession>;
        return start.call(
            this.voiceEngine, target, this.apiConfig.baseUrl(), this.oauth.getAccessToken(),
            deviceId, livekit,
        );
    }

    /** Open or close the microphone for this call, leaving any other call's routing alone. */
    private setPttOpen(open: boolean): void {
        if (this.voiceSession) void this.voiceEngine.setPttOpen(this.voiceSession, open);
    }

    // ── Local publishing ──────────────────────────────────────────────────────

    private async publishVideoTrack(stream: MediaStream): Promise<void> {
        const callId = this.callId;
        const track = stream.getVideoTracks()[0];
        if (!callId || !track) return;
        this.localVideoTrack = track;

        // Published before it is declared. The declaration is what puts this client on the roster as
        // publishing, and announcing a track the SFU is not yet carrying gives peers a tile with
        // nothing behind it.
        await this.roomMedia.publishTrack?.(track, 'video');
        if (this.callId !== callId) return;

        if (!await this.declarePublish(callId, ['video'], track)) {
            void this.roomMedia.unpublishTrack?.('video');
            // Refused outright. The local toggle is still on, so put it back rather than leaving a
            // camera button that reads as live over a track that has been stopped.
            this.localVideoTrack = null;
            void this.callSession.toggleCamera();
            return;
        }
        if (this.callId === callId) this.voiceWs.invokeCameraChanged(callId, true);
    }

    private async unpublishVideoTrack(): Promise<void> {
        const callId = this.callId;
        if (!callId) return;
        this.localVideoTrack = null;
        await this.roomMedia.unpublishTrack?.('video');

        // Marks the track closed so peers drop it rather than waiting on media that has ended.
        // Best-effort: the room already stopped sending, and the sweep covers a failed declaration.
        await firstValueFrom(this.voiceService.unpublish(callId, ['video'])).catch(() => void 0);
        if (this.callId === callId) this.voiceWs.invokeCameraChanged(callId, false);
    }

    private async publishScreenTrack(shareId: string, stream: MediaStream): Promise<void> {
        const callId = this.callId;
        const track = stream.getVideoTracks()[0];
        if (!callId || !track) return;
        this.localScreenTrack = track;
        this.screenShareId = shareId;

        // A DM share has always been published from the webview, unlike the guild one, so this goes
        // through the same room as the camera rather than through the Rust publisher.
        const trackName = screenTrackName(shareId);
        await this.roomMedia.publishTrack?.(track, trackName);
        if (this.callId !== callId) return;

        if (!await this.declarePublish(callId, [trackName], track)) {
            void this.roomMedia.unpublishTrack?.(trackName);
            this.localScreenTrack = null;
            this.screenShareId = null;
            void this.callSession.toggleScreenShare();
            return;
        }
        if (this.callId === callId) this.voiceWs.invokeScreenShareStarted(callId, shareId);
    }

    private async unpublishScreenTrack(): Promise<void> {
        const callId = this.callId;
        const shareId = this.screenShareId;
        if (!callId) return;
        this.localScreenTrack = null;
        this.screenShareId = null;
        if (!shareId) return;

        await this.roomMedia.unpublishTrack?.(screenTrackName(shareId));
        await firstValueFrom(this.voiceService.unpublish(callId, [screenTrackName(shareId)]))
            .catch(() => void 0);
        if (this.callId === callId) this.voiceWs.invokeScreenShareStopped(callId, shareId);
    }

    /**
     * Declare a publication, and settle what the room will actually let out of it.
     *
     * <p>Three answers, and only one of them is "nothing happened". A plain `200` is the ordinary
     * case. A `200` carrying `degradations` is a publish that <b>worked, smaller</b>: the granted
     * height and framerate are applied to the live track and re-declared, and nothing is rolled
     * back. A `403` is a refusal that could not degrade - the local track is stopped, because the
     * token this client connected with does not permit it either and nobody would receive it
     * whatever is retried.</p>
     *
     * <p>Anything else is a failed <i>declaration</i>, not a failed publish. The media is unaffected
     * by it and the next heartbeat is what corrects the server's record, so stopping the capture
     * over one would take a working stream down for a transient error.</p>
     *
     * <p>Answers whether the publication survived, so the caller can put the UI back.</p>
     */
    private async declarePublish(
        callId: string,
        trackNames: string[],
        track: MediaStreamTrack,
    ): Promise<boolean> {
        try {
            const reply = await firstValueFrom(
                this.voiceService.publish(callId, {trackNames, video: videoIntentOf(track)}),
            );
            if (this.callId !== callId) return false;

            // Absent and empty mean the same thing and are the normal case.
            if (reply.degradations?.length && reply.height && reply.framerate) {
                await this.clampTo(track, {height: reply.height, framerate: reply.framerate});
                await this.redeclareVideo(track);
            }
            return true;
        } catch (err) {
            if (!(err instanceof HttpErrorResponse) || err.status !== 403) {
                console.error('[call] publish declaration failed', {trackNames}, err);
                return true;
            }
            track.stop();
            console.warn('[call] publish refused', {trackNames}, err);
            // A refusal that carries a denial says which side bound and what to do about it, which
            // is the case worth a sentence. The fallback borrows the connect string until a
            // publish-specific one lands - the locales are a submodule and need their own commit.
            const denial = describeEntitlementDenial(err);
            this.toast.error(this.translate.instant(denial?.messageKey ?? 'CALL.CONNECT_FAILED'));
            return false;
        }
    }

    /**
     * Re-encode a live track to the rung the server granted.
     *
     * <p>`applyConstraints` rather than a sender parameter, because there is no sender here any
     * more: the SDK owns the encoding and the capture is the only thing this service can move. A
     * refusal is logged and left - the declaration below it still tells the server the truth about
     * what is being sent, which is what the ceiling is applied to.</p>
     */
    private async clampTo(track: MediaStreamTrack, granted: VideoPublishIntentDto): Promise<void> {
        try {
            await track.applyConstraints({height: granted.height, frameRate: granted.framerate});
        } catch (e) {
            console.warn('[call] could not re-encode to the granted rung', granted, e);
        }
    }

    /**
     * Tell the server the size of a publication that changed without republishing.
     *
     * <p>A ceiling computed once at publish time is one a later resolution change walks straight
     * past - a share that switches source, a camera that comes back at a different size. This never
     * refuses anything, so there is no failure path worth surfacing; an unchanged resolution needs
     * no call at all, which is why an unreadable track sends nothing rather than sending zeroes.</p>
     */
    private async redeclareVideo(track: MediaStreamTrack): Promise<void> {
        const callId = this.callId;
        const video = videoIntentOf(track);
        if (!callId || !video) return;
        await firstValueFrom(this.voiceService.declareVideo(callId, video)).catch(() => void 0);
    }

    // ── Remote audio, onto the Rust mixer ─────────────────────────────────────

    /**
     * Pull a remote audio track into the Rust mixer.
     *
     * <p>Audio never reaches this room. It is decoded and mixed in Rust and played through the
     * output device Rust owns, which is where AEC and per-source volume live - and subscribing to it
     * here as well would play the room twice.</p>
     */
    private async subscribeToTrack(
        userId: string,
        remoteMediaSessionId: string,
        trackName: string,
        kind: 'audio' | 'screenAudio',
    ): Promise<void> {
        if (kind === 'screenAudio') {
            await this.subscribeScreenAudio(userId, remoteMediaSessionId, trackName);
            return;
        }

        if (this.subscribedAudioUserIds.has(userId)) return;
        // Claimed before the wait below, not after: two announcements for the same user can both be
        // in flight, and the guard is the only thing stopping the second from subscribing again
        // behind the first.
        this.subscribedAudioUserIds.add(userId);

        const session = await this.awaitSession();
        if (!session) {
            // Released, so a later announcement or the next snapshot can retry. This used to return
            // silently while still holding the guard, which made the participant permanently
            // inaudible for the call.
            this.subscribedAudioUserIds.delete(userId);
            console.error('[call] dropped a subscribe - no session after waiting', {userId});
            return;
        }

        try {
            await this.voiceEngine.subscribe(session, userId, remoteMediaSessionId, trackName);
            this.participantsWithAudio.update(s => {
                const n = new Set(s);
                n.add(userId);
                return n;
            });
            const volume = this.userVolumes.get(userId);
            if (volume !== undefined) await this.voiceEngine.setUserVolume(userId, volume);
        } catch (e) {
            // Roll the guard back. Every retry route - live ParticipantJoined, the syncParticipants
            // backfill, the reconnect resync - is gated behind it, so leaving it consumed makes one
            // failure permanent.
            //
            // No stale-subscription branch any more: there is no subscribe request for the backend
            // to refuse, so what reaches here is genuine transport failure and the next roster read
            // is what retries it (design §8).
            this.subscribedAudioUserIds.delete(userId);
            console.error('[call] audio subscribe failed', {userId, trackName}, e);
        }
    }

    /**
     * Pull a share's own sound into the Rust mixer.
     *
     * <p>Keyed by track name, not by user: a participant's voice and the audio of the stream they
     * are sharing are two sources, and muting the stream must leave the person audible. That is
     * also why this cannot go through the `'audio'` branch above, which keys on the user id.</p>
     */
    private async subscribeScreenAudio(
        userId: string,
        remoteMediaSessionId: string,
        trackName: string,
    ): Promise<void> {
        if (this.remoteScreenAudioIds.get(userId) === trackName) return;

        const session = await this.awaitSession();
        if (!session) {
            console.error('[call] dropped a screen-audio subscribe - no session', {trackName});
            return;
        }

        try {
            await this.voiceEngine.subscribe(session, trackName, remoteMediaSessionId, trackName);
            this.remoteScreenAudioIds.set(userId, trackName);
            // A share that starts while its author is already muted must stay muted - the mute is a
            // statement about that participant's stream, not about the track that happens to carry
            // it, and a restarted share would otherwise come back at full volume.
            if (this.screenAudioMutedSignal().has(userId)) {
                await this.voiceEngine.setUserVolume(trackName, 0);
            } else {
                // Re-apply the stored slider position, exactly as the audio branch does for voice:
                // Rust starts every source at unity, and a volume set before this share existed (or
                // before it restarted at a new track name) would otherwise be silently lost.
                const volume = this.screenVolumes.get(userId);
                if (volume !== undefined) await this.voiceEngine.setUserVolume(trackName, volume);
            }
        } catch (e) {
            console.error('[call] screen-audio subscribe failed', {userId, trackName}, e);
        }
    }

    /**
     * Unwind whatever share audio we hold for a participant who has gone.
     *
     * The mute flag deliberately survives: it is a preference about that person's streams, and
     * clearing it would un-mute a noisy sharer the moment they reconnect.
     */
    private dropScreenAudio(userId: string): void {
        const sourceId = this.remoteScreenAudioIds.get(userId);
        if (!sourceId) return;
        void this.dropSource(sourceId);
        this.remoteScreenAudioIds.delete(userId);
    }

    /**
     * Wait for this call's publication to exist, rather than dropping a subscribe that arrived
     * before it.
     *
     * <p>The server announces every publisher the moment we are on the roster, and this client sets
     * up its listeners *before* `voiceEngine.start()` resolves - so every participant already in the
     * call is announced while `voiceSession` is still null. The snapshot refetch after connect
     * covers most of it, but an announcement landing inside that window has nothing to retry it.</p>
     */
    private async awaitSession(): Promise<VoiceSession | null> {
        if (this.voiceSession) return this.voiceSession;
        for (const delay of SESSION_WAIT_DELAYS_MS) {
            await new Promise(r => setTimeout(r, delay));
            if (this.voiceSession) return this.voiceSession;
        }
        return this.voiceSession;
    }

    /** Drop a source from this call's publication. Null-safe: WS events outlive the call. */
    private async dropSource(id: string): Promise<void> {
        if (this.voiceSession) await this.voiceEngine.unsubscribe(this.voiceSession, id);
    }

    // ── Remote video, on this room ────────────────────────────────────────────

    /**
     * Move one subscription per difference between what the roster asked for and what the room
     * holds, then hand the result to the UI.
     *
     * <p>A diff rather than a rebuild. Rebuilding would drop and re-pull every tile on any change,
     * which costs a keyframe each and shows as a room-wide flicker whenever one person turns a
     * camera on.</p>
     */
    private reconcileVideo(tracks: ReadonlyMap<string, RemoteMediaTrack>): void {
        const held = new Map<string, RemoteMediaTrack>();
        for (const track of tracks.values()) held.set(track.publication.trackName, track);

        // Close what the roster dropped. Also what a reconnect that restored a broader subscription
        // than we asked for leaves behind, which is why this runs over what the room reports rather
        // than over what we remember asking for.
        for (const [name, track] of held) {
            if (!this.wantedVideo.has(name)) this.livekit.setSubscribed(track.trackSid, false);
        }

        // Open what the roster added.
        for (const [name, want] of this.wantedVideo) {
            if (!held.has(name)) this.subscribeVideo(name, want);
        }

        this.applyAttachments(held);
    }

    /**
     * Pull one remote video track by the name the roster knows it by.
     *
     * <p>The roster, the snapshot and every `TrackPublished` speak track *names*; `setSubscribed`
     * addresses the SFU's sid. {@link RoomPublishing.publicationsOf} is the only bridge, because a
     * publication this room has not subscribed to yet appears nowhere else.</p>
     *
     * <p>A name the SDK has not heard of is not an error: SignalR and the signalling socket race,
     * and either can win. Counted and left for the next reconcile, which every arriving track
     * triggers.</p>
     */
    private subscribeVideo(trackName: string, want: WantedVideo): void {
        const sid = this.roomMedia.publicationsOf?.(want.userId)
            ?.find(p => p.trackName === trackName)?.trackSid;
        if (!sid) {
            this.unresolvedVideoSignal.update(n => n + 1);
            return;
        }
        this.livekit.setSubscribed(sid, true);
    }

    /**
     * The publish half of the room, or an empty object when the wrapper does not carry it.
     *
     * <p>See {@link RoomPublishing}. Said once and loudly rather than per call: a missing method
     * here is a build that cannot publish a camera or resolve a roster row to a sid at all, which is
     * a wiring fault and not a condition to degrade quietly around.</p>
     */
    private get roomMedia(): Partial<RoomPublishing> {
        const room = this.livekit as unknown as Partial<RoomPublishing>;
        if (!this.warnedMissingRoomSurface && typeof room.publishTrack !== 'function') {
            this.warnedMissingRoomSurface = true;
            console.error(
                '[call] the room wrapper carries no publish/publications surface - ' +
                'cameras and shares cannot be published and roster rows cannot be resolved to track sids',
            );
        }
        return room;
    }

    /**
     * Hand the room's video to the UI, and take back what has gone.
     *
     * <p>Departures first, so a share that restarted under a new name is not torn down again by the
     * departure of the one it replaced.</p>
     */
    private applyAttachments(held: ReadonlyMap<string, RemoteMediaTrack>): void {
        for (const [name, was] of [...this.attachedVideo]) {
            if (held.has(name)) continue;
            this.attachedVideo.delete(name);
            if (was.kind === 'video') this.callSession.onCameraChanged(was.userId, false);
            else if (was.shareId) this.callSession.onScreenShareStopped(was.shareId);
        }

        for (const [name, track] of held) {
            if (this.attachedVideo.has(name)) continue;
            const media = track.publication.track?.mediaStreamTrack;
            // Subscribed, media not attached yet. Ordinary, and the next pass picks it up.
            if (!media) continue;

            // `describeTrack` is the only thing that decides what a name means, here as everywhere -
            // and it tests `screen-audio-` before `screen-`, which is what keeps a share's audio
            // from reading as the video of a share whose id starts with `audio-`.
            const {kind, shareId} = describeTrack(name);
            const stream = new MediaStream([media]);
            if (kind === 'video') {
                this.callSession.onCameraChanged(track.userId, true, stream);
            } else if (kind === 'screen' && shareId) {
                this.callSession.onScreenShareStarted(shareId, track.userId, stream);
            } else {
                // Audio of either kind belongs to the Rust room and must never be played here.
                continue;
            }
            this.attachedVideo.set(name, {userId: track.userId, kind: kind === 'video' ? 'video' : 'screen', shareId});
        }
    }

    /** Record a remote video track as wanted, and act on it. */
    private wantVideo(trackName: string, want: WantedVideo): void {
        this.wantedVideo.set(trackName, want);
        this.reconcileVideo(this.livekit.remoteTracks());
    }

    /** Forget a remote video track, and drop the subscription if one is held. */
    private dropVideo(trackName: string): void {
        this.wantedVideo.delete(trackName);
        this.reconcileVideo(this.livekit.remoteTracks());
    }

    /** Everything this user was publishing, gone at once - a departure or an eviction. */
    private dropAllVideoOf(userId: string): void {
        for (const [name, want] of [...this.wantedVideo]) {
            if (want.userId === userId) this.wantedVideo.delete(name);
        }
        this.reconcileVideo(this.livekit.remoteTracks());
    }

    // ── Stats polling ─────────────────────────────────────────────────────────

    private startStatsPolling(): void {
        this.prevBytes = {inAudio: 0, inVideo: 0};
        this.prevStatsTs = 0;
        this.armStatsInterval();
    }

    /** 1s while a stats panel is open, 2s otherwise - see the twin on `VoiceRTCService`. */
    private armStatsInterval(): void {
        clearInterval(this.statsInterval);
        const period = this.inspected() ? 1000 : 2000;
        this.statsInterval = setInterval(() => void this.pollStats(), period);
    }

    /**
     * Stop polling and forget everything the poll produced.
     *
     * <p><b>`inspected` is cleared here too</b> - see the twin on `VoiceRTCService` for the full
     * reasoning. Short version: this service is `providedIn: 'root'` and outlives any one call, so
     * an inspection left set by a tile destroyed with its panel open would pin
     * {@link armStatsInterval} at the 1s diagnostics cadence for every later call as well.</p>
     */
    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.stats.set(null);
        this.inboundVideoFpsByShareSignal.set({});
        this.inspected.set(null);
        this.inspectedStats.set(null);
        this.prevStatsTs = 0;
        this.prevInboundBytes.clear();
        this.prevInboundAt = 0;
    }

    /**
     * Every subscribed video receiver's statistics, merged, plus the mid → owner map the two
     * readers need.
     *
     * <p>The mid is still the key, and is now read out of each receiver's own report rather than off
     * a transceiver this service owns - nothing here holds one any more. Building the map from the
     * same pass that collects the stats is what keeps the two from disagreeing: a track that
     * appeared between the two reads cannot end up in one and not the other.</p>
     */
    private async inboundReport(): Promise<{report: StatsLike; owners: ReadonlyMap<string, InboundTrackOwner>}> {
        const stats: RTCStats[] = [];
        const owners = new Map<string, InboundTrackOwner>();

        for (const held of this.livekit.remoteTracks().values()) {
            const {kind, shareId} = describeTrack(held.publication.trackName);
            // Audio of either kind is the Rust room's and is never subscribed here; guarding on it
            // keeps a stray subscription out of the video accounting rather than trusting it not to
            // exist.
            if (kind !== 'video' && kind !== 'screen') continue;

            const report = await held.publication.track?.getRTCStatsReport();
            if (!report) continue;

            report.forEach(stat => {
                stats.push(stat);
                if (stat.type !== 'inbound-rtp') return;
                const mid = (stat as RTCInboundRtpStreamStats).mid;
                if (mid) owners.set(mid, {userId: held.userId, kind, shareId: shareId ?? undefined});
            });
        }

        return {report: {forEach: callback => stats.forEach(callback)}, owners};
    }

    private async pollStats(): Promise<void> {
        if (!this.callId) return;
        const {report, owners} = await this.inboundReport();
        const now = Date.now();

        // Independent of the kbps accounting below, which needs two samples to produce a rate -
        // framesPerSecond arrives from the browser pre-computed, so there is no reason to wait for a
        // second poll before showing it.
        this.inboundVideoFpsByShareSignal.set(inboundScreenFpsByShare(report, owners));
        // One extra pass over reports that were fetched anyway, and only while a panel is open.
        const inspectedSnapshot = detailedStatsForShare(report, owners, this.inspected()?.shareId ?? null);
        this.inspectedStats.set(this.withMeasuredBitrate(inspectedSnapshot));

        let inAudio = 0, inVideo = 0, packetsLost = 0;
        report.forEach((stat: RTCStats) => {
            if (stat.type !== 'inbound-rtp') return;
            const s = stat as RTCInboundRtpStreamStats;
            if (s.kind === 'audio') inAudio += s.bytesReceived ?? 0;
            else inVideo += s.bytesReceived ?? 0;
            packetsLost += s.packetsLost ?? 0;
        });

        if (!this.prevStatsTs) {
            this.prevBytes = {inAudio, inVideo};
            this.prevStatsTs = now;
            return;
        }

        const dt = (now - this.prevStatsTs) / 1000;
        const kbps = (cur: number, prev: number) =>
            Math.max(0, Math.round(((cur - prev) * 8) / dt / 1000));

        this.stats.set({
            inboundKbps: kbps(inAudio + inVideo, this.prevBytes.inAudio + this.prevBytes.inVideo),
            inboundAudioKbps: kbps(inAudio, this.prevBytes.inAudio),
            inboundVideoKbps: kbps(inVideo, this.prevBytes.inVideo),
            // Zero rather than measured, and this is the honest reading rather than a stub: this
            // room only receives. What this client sends leaves on the Rust connection, whose
            // counters are `RustMediaService.pollOutbound`'s, and the room wrapper exposes no local
            // publication to read a webview publication's off.
            outboundKbps: 0,
            outboundAudioKbps: 0,
            outboundVideoKbps: 0,
            packetsLost,
        });

        this.prevBytes = {inAudio, inVideo};
        this.prevStatsTs = now;
    }

    /**
     * Turn this poll's cumulative `bytesReceived` into a per-layer `kbps`, against the last one.
     *
     * <p>The first poll of a freshly opened panel has no predecessor and so produces no rate at
     * all, which is the honest answer: `kbpsBetween` returns undefined rather than zero, and the
     * bitrate row is simply absent for one tick instead of claiming the stream is silent. Kept
     * structurally identical to `VoiceRTCService.withMeasuredBitrate` on purpose - the two services
     * are deliberate near-twins and drift between them is the thing that hides bugs.</p>
     *
     * <p>Deliberately separate from the aggregate kbps accounting above it. That one totals the
     * whole room and answers "how much is this call using"; this one attributes bytes to one
     * stream's layers and answers "is this rung actually arriving", which is the question the panel
     * was built for and the one no aggregate can answer.</p>
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

    // ── Authoritative state reconciliation ────────────────────────────────────

    /**
     * Checks the ring lifecycle and reconciles media against the room snapshot.
     *
     * <p>Two reads, because they answer different questions and only one of them has media in it.
     * `getCall` carries the ring state - was the call completed or rejected, are we still an invited
     * participant - and no media handles at all. `getCallSnapshot` carries who is pullable, on which
     * identity, and which screen-share tracks are live. The old code did the whole job from the call
     * DTO, which is why it could restore audio and never a screen share.</p>
     *
     * <p>Called once at connect() (covers joining a call already in progress) and on every SignalR
     * reconnect (covers events dropped during the gap, since SignalR does not queue undelivered
     * messages for a lapsed connection).</p>
     */
    private async syncParticipants(): Promise<void> {
        const callId = this.callId;
        if (!callId) return;

        let fresh: CallDto;
        try {
            fresh = await firstValueFrom(this.voiceService.getCall(callId));
        } catch {
            return; // Best-effort - a later reconnect or live event will catch up.
        }
        if (this.callId !== callId) return; // Call ended/changed while the request was in flight

        const s = this.callSession.session();
        if (!s) return;
        const ownId = s.participants.find(p => p.isLocal)?.userId;

        // Through the normaliser, not compared raw: the same field reaches us as `"Completed"` or
        // as the ordinal, depending on whether the host serialising it has JsonStringEnumConverter.
        const freshStatus = callStatusName(fresh.status);
        if (freshStatus === 'Completed' || freshStatus === 'Rejected') {
            this.callSession.end();
            return;
        }
        // ownId can be unresolved this early if profileService.ownProfile() hadn't loaded yet when
        // join() computed isLocal (every participant then reads isLocal: false). Treating "no
        // participant matches undefined" as "I was removed" would hang up a call that's actually
        // fine - only act on this check once ownId is actually known.
        if (ownId && !fresh.participants.some(p => p.userId === ownId)) {
            this.callSession.end();
            return;
        }

        await this.refetchSnapshot();
    }

    /**
     * Decide what an arriving event means, and act on it.
     *
     * <p>Events for a different call are ignored outright rather than gated - this client is only
     * ever in one call, so anything else is stale routing.</p>
     */
    private gate(event: VoiceEventEnvelope, apply: () => void): void {
        this.decide(apply, () => this.tracker.receive(event));
    }

    /** The same, for relay events - applied without advancing the version. */
    private gateRelay(event: VoiceEventEnvelope, apply: () => void): void {
        this.decide(apply, () => this.tracker.receiveRelay(event));
    }

    private decide(apply: () => void, classify: () => VoiceEventDecision): void {
        switch (classify()) {
            case 'apply':
                apply();
                return;
            case 'ignore':
                return;
            case 'refetch':
                void this.refetchSnapshot();
                return;
        }
    }

    /**
     * Read the room's authoritative state again.
     *
     * <p>Best-effort: a failed read is covered by the next heartbeat, which asserts a version the
     * server disagrees with and gets a snapshot pushed back.</p>
     */
    private async refetchSnapshot(): Promise<void> {
        const callId = this.callId;
        if (!callId || this.refetchInFlight) return;

        this.refetchInFlight = true;
        try {
            const snapshot = await firstValueFrom(this.voiceService.getCallSnapshot(callId));
            if (this.callId !== callId) return;
            this.applySnapshot(snapshot);
        } catch (err) {
            console.error('[call] snapshot refetch failed', err);
        } finally {
            this.refetchInFlight = false;
        }
    }

    /**
     * Take the snapshot and reconcile media against it.
     *
     * <p>The snapshot carries the media handles the old response shape withheld, so one read
     * restores every subscription - including screen shares, which nothing could restore before,
     * because the track name is a UUID chosen by the publisher and appeared in no state a joiner
     * could read.</p>
     */
    private applySnapshot(snapshot: VoiceRoomSnapshot): void {
        if (snapshot.roomId !== this.callId) return;
        this.tracker.applySnapshot(snapshot);

        const s = this.callSession.session();
        if (!s) return;
        const ownId = s.participants.find(p => p.isLocal)?.userId;

        const present = new Set(snapshot.participants.map(p => p.userId));
        for (const p of s.participants) {
            if (!p.isLocal && !present.has(p.userId)) {
                this.callSession.onParticipantLeft(p.userId);
                this.subscribedAudioUserIds.delete(p.userId);
                this.dropScreenAudio(p.userId);
                void this.dropSource(p.userId);
            }
        }

        // Cameras carried over rather than rebuilt: the snapshot lists shares and has no camera
        // track in it at all, so a camera is known only from `TrackPublished` and would be dropped
        // by every refetch if this were a straight rebuild. Anything belonging to somebody the
        // snapshot no longer lists goes, which is the half a rebuild was there for.
        for (const [name, want] of [...this.wantedVideo]) {
            if (want.kind !== 'video' || !present.has(want.userId)) this.wantedVideo.delete(name);
        }

        for (const p of snapshot.participants) {
            if (p.userId === ownId) continue;
            this.callSession.onParticipantJoined(p.userId);
            // A roster row alone is not an invitation to subscribe: `Joined` means a connection
            // exists and a microphone track does not.
            //
            // `mediaSessionId` is the LiveKit identity now, and the Rust room answers `""` for its
            // own rather than fabricating one - so an empty string is a legitimate value here and
            // must not read as "not publishing". `publishState` is what decides that.
            if (p.publishState !== 'Publishing' || !p.audioTrackName) continue;

            void this.subscribeToTrack(p.userId, p.mediaSessionId ?? '', p.audioTrackName, 'audio');

            for (const share of p.shares) {
                // A null share identity no longer means "unpullable". Desktop publishes its shares
                // on the participant's own identity now that one connection carries every track it
                // sends, so the field is only set by a client that still splits them - see
                // `VoiceShareSnapshot.mediaSessionId`.
                const shareIdentity = share.mediaSessionId ?? p.mediaSessionId ?? '';

                for (const trackName of share.trackNames) {
                    const {kind} = describeTrack(trackName);
                    // Both halves, each on its own transport: the video onto this room, the audio
                    // onto the Rust mixer where the volume and mute controls live.
                    if (kind === 'screenAudio') {
                        void this.subscribeToTrack(p.userId, shareIdentity, trackName, 'screenAudio');
                    } else {
                        this.wantedVideo.set(trackName, {
                            userId: p.userId, kind: 'screen', shareId: share.shareId,
                        });
                    }
                }
            }
        }

        this.reconcileVideo(this.livekit.remoteTracks());
    }

    /**
     * "You are behind" - or, on `roomGone`, "this call is over".
     *
     * <p>Deliberately not version-gated: a resync is an instruction rather than state, and
     * `roomGone` carries a blank instance and version zero, which the tracker would classify as a
     * stale duplicate.</p>
     */
    private onResync(reason: string): void {
        if (reason === 'roomGone') {
            this.callSession.end(true);
            return;
        }
        void this.refetchSnapshot();
    }

    /** What this client asserts about itself on every beat. Honest, including when not publishing. */
    private sendHeartbeat(): void {
        if (!this.callId) return;
        this.voiceWs.invokeVoiceHeartbeat(this.callId, {
            knownInstanceId: this.tracker.instanceId,
            knownVersion: this.tracker.version,
            // The Rust publication's identity, not this room's. This connection is secondary and
            // receive-only; asserting `{userId}#view` would hand peers an identity with no audio
            // track on it. The empty string the Rust engine answers with is a legitimate value and
            // is passed through rather than collapsed to null - it says "publishing", and only
            // `voiceSession` being absent says otherwise.
            mediaSessionId: this.voiceSession ? this.voiceSession.mediaSessionId : null,
            audioTrackName: this.voiceSession ? this.voiceSession.trackName : null,
        });
    }

    // ── SignalR event listeners ───────────────────────────────────────────────

    private setupWsListeners(): void {
        this.wsSubs = [
            // Someone joined → add to UI and pull their audio onto the Rust mixer.
            this.voiceWs.participantJoinedObservable.subscribe(e => this.gate(e, () => {
                this.callSession.onParticipantJoined(e.userId);
                // Our own announcement reaches us too, and pulling our own microphone back would
                // put us in the mix twice.
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return;
                void this.subscribeToTrack(e.userId, e.mediaSessionId, e.audioTrackName, 'audio');
            })),

            // New video / screen track published → want it.
            this.voiceWs.trackPublishedObservable.subscribe(e => this.gate(e, () => {
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return; // Skip own tracks
                if (e.kind === 'video') {
                    this.wantVideo(e.trackName, {userId: e.userId, kind: 'video', shareId: null});
                } else if (e.kind === 'screen') {
                    this.wantVideo(e.trackName, {
                        userId: e.userId, kind: 'screen', shareId: e.shareId ?? null,
                    });
                } else if (e.kind === 'screenAudio') {
                    void this.subscribeToTrack(e.userId, e.mediaSessionId, e.trackName, 'screenAudio');
                }
            })),

            // Authoritative state, pushed on join, on publish, and whenever the server decides we
            // are out of date. Applied wholesale - it is not a delta.
            this.voiceWs.voiceSnapshotObservable.subscribe(s => this.applySnapshot(s)),
            this.voiceWs.voiceResyncObservable.subscribe(e => {
                if (e.callId === this.callId) this.onResync(e.reason);
            }),

            // A track stopped.
            this.voiceWs.trackClosedObservable.subscribe(e => this.gate(e, () => {
                const {kind, shareId} = describeTrack(e.trackName);
                if (kind === 'screenAudio') {
                    // Dropped, or a stopped share keeps its slot in the mixer forever - silent, but
                    // still popped and mixed on every frame.
                    void this.dropSource(e.trackName);
                    this.remoteScreenAudioIds.delete(e.userId);
                    return;
                }
                // Both, and the overlap is deliberate. Dropping the demand is what unwinds the
                // subscription, and the reconcile that follows the SDK's unsubscribe tells the UI -
                // but a close for a track this room never held reconciles to nothing, so the tile
                // is cleared here as well. Every step is idempotent, which is what makes that safe.
                this.dropVideo(e.trackName);
                if (kind === 'screen' && shareId) this.callSession.onScreenShareStopped(shareId);
                else if (kind === 'video') this.callSession.onCameraChanged(e.userId, false);
            })),

            // Remote mute/speaking/camera state changes
            this.voiceWs.muteChangedObservable.subscribe(e => this.gate(e, () =>
                this.callSession.onMuteChanged(e.userId, e.isMuted))),

            // Relay, and the highest-frequency one there is - applied without advancing the
            // version and without gap detection, so a room we cannot resynchronise does not refetch
            // at speaking rate.
            this.voiceWs.speakingChangedObservable.subscribe(e => this.gateRelay(e, () =>
                this.callSession.onSpeakingChanged(e.userId, e.isSpeaking))),

            // Relay: not stored server-side, not versioned. See VoiceRoomTracker.receiveRelay.
            this.voiceWs.cameraChangedObservable.subscribe(e => this.gateRelay(e, () => {
                // Turn-off: update the UI immediately. Turn-on is handled by TrackPublished, which
                // is what carries the track name there is nothing to pull without.
                if (!e.isCameraOn) this.callSession.onCameraChanged(e.userId, false);
            })),

            // Screen share start: surface in the UI immediately, before any media arrives.
            this.voiceWs.screenShareStartedObservable.subscribe(e => this.gate(e, () => {
                this.callSession.onScreenShareStarted(e.shareId, e.userId, undefined);
            })),

            this.voiceWs.screenShareStoppedObservable.subscribe(e => this.gate(e, () =>
                this.callSession.onScreenShareStopped(e.shareId))),

            // Someone left → drop them from the UI and unwind everything we hold for them. The
            // only departure event the contract carries, so this is the sole teardown path for a
            // live departure; `syncParticipants` repeats it for departures missed while offline.
            // Every step is idempotent, which is what makes that overlap harmless.
            this.voiceWs.callParticipantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
                this.subscribedAudioUserIds.delete(e.userId);
                this.dropScreenAudio(e.userId);
                this.dropAllVideoOf(e.userId);
                void this.dropSource(e.userId);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(e.userId);
                    return n;
                });
            }),

            // Everyone else left; the server will force-end the call at this deadline.
            this.voiceWs.callAloneObservable.subscribe(e => {
                if (e.callId !== this.callId) return;
                this.callSession.setAloneDeadline(new Date(e.deadline));
            }),

            // The call ended for someone else's reason - the server has already torn it down.
            this.voiceWs.callEndedObservable.subscribe(e => {
                // `wasActive` is what keeps a self-initiated hangup silent: clicking hang up
                // nulls session() synchronously, before any CallEnded broadcast can arrive. So
                // this only speaks up when the call ended for a reason the user did not cause.
                const wasActive = !!this.callSession.session();
                this.callSession.end(true);
                if (wasActive) this.toast.info(describeCallEndedReason(e.reason));
            }),
        ];
    }
}
