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
    MICROPHONE_TRACK,
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
 * Backoff waiting for this call's Rust publication before giving up on a subscribe, in ms.
 * Announcements for participants already in the call land while `voiceEngine.start()` is pending.
 */
export const SESSION_WAIT_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * What a video publish is about to send, read off the track the device actually opened.
 * Read from `getSettings`, not the constraint: undefined when either half is unknown, which omits
 * the field so the server does not clamp against a resolution nothing is sending.
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
 * Keyed by share, not user: a stale share can briefly sit beside its replacement under one user.
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

/** How the SDK's connection state reads to a call panel that speaks `RTCPeerConnectionState`. */
const RTC_STATE_BY_CONNECTION: Record<LiveKitConnectionState, RTCPeerConnectionState> = {
    [LiveKitConnectionState.Disconnected]: 'new',
    [LiveKitConnectionState.Connecting]: 'connecting',
    [LiveKitConnectionState.Connected]: 'connected',
    [LiveKitConnectionState.Reconnecting]: 'connecting',
    [LiveKitConnectionState.SignalReconnecting]: 'connecting',
};

/**
 * Everything about a DM call that is not negotiation. `CallSessionService` owns the UI state.
 *
 * Two transports, and the split must hold: the Rust room holds the primary identity and every audio
 * track; this service's `view`-tagged secondary connection carries video only. Pulling audio here
 * too would play the room twice, and the second copy is not muteable from any visible control.
 */
@Injectable({providedIn: 'root'})
export class CallWebRtcService {
    // ── Stats polling ────────────────────────────────────────────────────────
    readonly stats = signal<CallStats | null>(null);
    /**
     * Remote screen shares' arriving frame rate, keyed by share id, never by user id: a stale share
     * can sit beside its replacement under one user and would silently report the other's number.
     * A share missing from this map renders as "no data", not 0.
     */
    private readonly inboundVideoFpsByShareSignal = signal<Record<string, number>>({});
    readonly inboundVideoFpsByShare = this.inboundVideoFpsByShareSignal.asReadonly();
    /** See the twin on `VoiceRTCService`. This service uses `shareId` and ignores `userId`. */
    readonly inspected = signal<{shareId: string; userId: string} | null>(null);
    readonly inspectedStats = signal<StreamStatsSnapshot | null>(null);

    /** The previous poll's cumulative `bytesReceived`, per layer, and when it was taken. */
    private prevInboundBytes = new Map<string, number>();
    private prevInboundAt = 0;

    // ── Connection state ──────────────────────────────────────────────────────
    private readonly engineUp = signal(false);
    private livekit = inject(LiveKitRoomService);

    /**
     * What the call UI shows as the connection state. This room only receives, so with nothing
     * published it sits short of `Connected` and the Rust engine speaks for it instead.
     */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const state = RTC_STATE_BY_CONNECTION[this.livekit.state()] ?? 'new';
        return state === 'new' && this.engineUp() ? 'connected' : state;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    private callSession = inject(CallSessionService);

    /**
     * What the token this client connected with actually grants. The mic and camera buttons must
     * render from these, not from locally computed permission: the node enforces the minted rights.
     */
    private readonly canPublishAudioSignal = signal(true);
    readonly canPublishAudio = this.canPublishAudioSignal.asReadonly();
    private readonly canPublishVideoSignal = signal(true);
    readonly canPublishVideo = this.canPublishVideoSignal.asReadonly();

    /** Narrow views of the session, so effects wake on a boolean flip, not on every rebuild. */
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
     * The Rust publication carrying this call's audio. Held, not looked up: the engine runs several
     * sessions at once (Isle proximity holds its own) and every command must name which one.
     */
    private voiceSession: VoiceSession | null = null;

    // ── Local publications ───────────────────────────────────────────────────
    private localVideoTrack: MediaStreamTrack | null = null;
    private localScreenTrack: MediaStreamTrack | null = null;
    private screenShareId: string | null = null;

    // Users already subscribed to for audio, so subscribeToTrack('audio') is idempotent per user.
    private readonly subscribedAudioUserIds = new Set<string>();
    // userId to the mixer source id of their share's audio, so the per-stream mute can find it.
    // The mixer source is keyed by track name, not user id: muting a share must not mute its author.
    private readonly remoteScreenAudioIds = new Map<string, string>();
    private readonly screenAudioMutedSignal = signal<Set<string>>(new Set());
    readonly screenAudioMuted = this.screenAudioMutedSignal.asReadonly();

    /**
     * What the roster says this room should be pulling, by track name. The demand, not the holding:
     * {@link reconcileVideo} diffs it against what the SDK reports.
     */
    private readonly wantedVideo = new Map<string, WantedVideo>();
    /** What has actually been handed to the UI, so a departure can be told from a late arrival. */
    private readonly attachedVideo = new Map<string, WantedVideo>();

    /** Roster rows not yet resolvable to a publication. Self-correcting; counted, not silent. */
    private readonly unresolvedVideoSignal = signal(0);
    readonly unresolvedVideo = this.unresolvedVideoSignal.asReadonly();
    /** Said once per session rather than per call - see {@link RoomPublishing}. */
    private warnedMissingRoomSurface = false;

    /** `instanceId`/`version` for this call and the event decision procedure. {@link VoiceRoomTracker} */
    private readonly tracker = new VoiceRoomTracker();
    private refetchInFlight = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private prevConnState: ConnectionState | null = null;
    // Per-user volume overrides (0-1.0), persisted for the call duration
    private readonly userVolumes = new Map<string, number>();
    // Per-share volume overrides (0-1.0). Its own map, not userVolumes: a stream's audio is a
    // different mixer source than its author's voice and the two adjust independently.
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
        // Re-declare what is being sent whenever the user changes quality mid-share. The publication
        // is unchanged, only its size, and `PUT .../video` is the only thing that reports that.
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

        // Everything the room hands us, reconciled against what the roster asked for. Signal-driven,
        // not callback-driven, so a track arriving before its roster row is picked up next pass.
        effect(() => {
            const tracks = this.livekit.remoteTracks();
            untracked(() => this.reconcileVideo(tracks));
        });

        // SignalR does not queue undelivered messages, so a reconnect means `call.*` events during
        // the gap were dropped. Re-sync authoritative state.
        effect(() => {
            const cs = this.voiceWs.connectionState();
            const wasConnected = this.prevConnState === ConnectionState.Connected;
            this.prevConnState = cs;
            if (cs === ConnectionState.Connected && !wasConnected && this.callId) {
                // Immediately, not at the next 30s tick: a disconnect shortens the server-side
                // liveness window. Nothing here rebuilds media; a hub blip says nothing about it.
                this.sendHeartbeat();
                void this.syncParticipants();
            }
        });

        // Apply local mute state and the push-to-talk gate. Only the mute toggle is broadcast to
        // peers; the PTT gate is purely local. They must stay separate facts in the Rust engine.
        // Reads `localMuted`, not `session()`, so this does not wake on every roster change.
        effect(() => {
            const isMuted = this.localMuted();
            // Mute is engine-wide (one microphone). The talk key is per call, so it names this
            // call's publication and cannot also open Isle proximity voice.
            void this.voiceEngine.setMute(isMuted);
            this.setPttOpen(this.callSession.pttGateOpen());
            if (isMuted === this.prevMuted) return;
            this.prevMuted = isMuted;
            if (this.callId) this.voiceWs.invokeMuteChange(this.callId, isMuted);
        });

        // Own speaking state, straight from the Rust gate that picks which frames are transmitted.
        // The session read must stay untracked: this effect writes the session via
        // onSpeakingChanged, so tracking it would retrigger the effect in an infinite loop.
        effect(() => {
            const speaking = this.voiceEngine.speaking();
            const localId = untracked(
                () => this.callSession.session()?.participants.find(p => p.isLocal)?.userId,
            );
            if (localId) this.callSession.onSpeakingChanged(localId, speaking);
        });

        // Apply local deafen state in the mixer that owns playout. Narrowed to `localDeafened` for
        // the same reason as the mute effect above.
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

        // Publish or unpublish the screen share track. A DM share publishes from the webview, not
        // from the Rust publisher as the guild path does.
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
     * Set one participant's stream volume, independent of their voice. While muted the level is
     * only remembered, never applied, so setting it cannot audibly un-mute the stream.
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
     * Mute or unmute one participant's shared stream, leaving their voice alone. The flag is
     * remembered with no live source, so it survives the share stopping and restarting.
     */
    toggleScreenAudioMute(userId: string): void {
        const willMute = !this.screenAudioMutedSignal().has(userId);
        const sourceId = this.remoteScreenAudioIds.get(userId);
        // Unmuting restores the stored volume, not unity: mute must not clobber the stored level.
        if (sourceId)
            void this.voiceEngine.setUserVolume(sourceId, willMute ? 0 : this.getScreenVolume(userId));
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            if (willMute) n.add(userId);
            else n.delete(userId);
            return n;
        });
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────

    /**
     * Open this call's room. Driven from an effect as `void this.connect(...)`, so the catch must
     * stay: a rejection has no call site, and `callId` left set blocks every later attempt.
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
        // One connection per user per tag: two connections sharing a tag share an identity and the
        // SFU evicts the earlier one, so `view` must never be reused for a second webview room and
        // the primary (bare user id, Rust microphone) must never be shared with this one.
        const [primary, view] = await Promise.all([
            firstValueFrom(this.voiceService.connection(callId, true)),
            firstValueFrom(this.voiceService.connection(callId, false, 'view')),
        ]);
        if (this.callId !== callId) return;

        // Each grant read off the connection that would exercise it: the microphone on the primary,
        // the camera and the share on this one.
        this.canPublishAudioSignal.set(primary.canPublishAudio);
        this.canPublishVideoSignal.set(view.canPublishVideo);

        await this.livekit.connect({url: view.url, token: view.token});
        if (this.callId !== callId) {
            void this.livekit.disconnect();
            return;
        }

        // Before the Rust publish, not after: the publish is what puts us on the roster and makes
        // the server re-announce every already-connected participant back to us.
        this.setupWsListeners();

        // Backfill in case that re-announce is missed. Every subscribe path is idempotent, which is
        // what makes this safe to race with the WS listener.
        void this.syncParticipants();

        // The microphone is captured and published entirely in Rust on the primary connection. The
        // connection must travel down rather than be fetched in Rust: only the webview's interceptor
        // chain can refresh an expired bearer and replay.
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

        // Declare the microphone. Until this lands the snapshot carries `publishState: "Joined"`,
        // and other clients skip a non-`Publishing` participant's shares entirely (guide §9 rule 1).
        // Not fatal if it fails; the 30s heartbeat asserts the same state and repairs it.
        await firstValueFrom(this.voiceService.publish(callId, {trackNames: [MICROPHONE_TRACK]})).catch(e =>
            console.error('[call] could not declare the microphone', e),
        );

        // Apply current mute state immediately: the user may have muted before connecting, and the
        // engine starts with its talk key up, which in push-to-talk mode means the gate is shut.
        const isMuted = this.callSession.session()?.local.isMuted ?? false;
        this.prevMuted = isMuted;
        void this.voiceEngine.setMute(isMuted);
        this.setPttOpen(this.callSession.pttGateOpen());

        // Read the room again now there is something to subscribe on. The snapshot pushed at join
        // arrives before the room and the Rust session exist, so its shares would be dropped.
        void this.refetchSnapshot();

        // Liveness and repair: this is what lets the server correct its record of what we are
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
        // The next call starts from nothing: two rooms have unrelated counters, and a carried-over
        // one makes the new call's first event read as a gap or as stale.
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
     * The connection must stay a typed argument and must never be passed through a cast: without it
     * Rust falls back to the Cloudflare route and the microphone 404s three layers down.
     */
    private startEngine(
        target: VoiceTarget,
        deviceId: string,
        livekit: {url: string; token: string},
    ): Promise<VoiceSession> {
        return this.voiceEngine.start(
            target,
            this.apiConfig.baseUrl(),
            this.oauth.getAccessToken(),
            deviceId,
            livekit,
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

        // Publish before declaring: declaring first announces a track the SFU is not yet carrying,
        // which gives peers a tile with nothing behind it.
        await this.roomMedia.publishTrack?.(track, 'video');
        if (this.callId !== callId) return;

        if (!(await this.declarePublish(callId, ['video'], track))) {
            void this.roomMedia.unpublishTrack?.('video');
            // Refused outright, and the local toggle is still on, so put it back.
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

        // A DM share publishes from the webview, so it goes through the same room as the camera
        // rather than through the Rust publisher the guild path uses.
        const trackName = screenTrackName(shareId);
        await this.roomMedia.publishTrack?.(track, trackName);
        if (this.callId !== callId) return;

        if (!(await this.declarePublish(callId, [trackName], track))) {
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
        await firstValueFrom(this.voiceService.unpublish(callId, [screenTrackName(shareId)])).catch(
            () => void 0,
        );
        if (this.callId === callId) this.voiceWs.invokeScreenShareStopped(callId, shareId);
    }

    /**
     * Declare a publication and settle what the room will let out of it. Answers whether the
     * publication survived. 200 with `degradations` is a publish that worked smaller and must not be
     * rolled back; 403 stops the track; anything else is a failed declaration, not a failed publish,
     * so the capture must survive it and the next heartbeat repairs the server's record.
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
            // The fallback borrows the connect string until a publish-specific one lands.
            const denial = describeEntitlementDenial(err);
            this.toast.error(this.translate.instant(denial?.messageKey ?? 'CALL.CONNECT_FAILED'));
            return false;
        }
    }

    /**
     * Re-encode a live track to the rung the server granted. `applyConstraints`, not a sender
     * parameter: the SDK owns the encoding and the capture is all this service can move.
     */
    private async clampTo(track: MediaStreamTrack, granted: VideoPublishIntentDto): Promise<void> {
        try {
            await track.applyConstraints({height: granted.height, frameRate: granted.framerate});
        } catch (e) {
            console.warn('[call] could not re-encode to the granted rung', granted, e);
        }
    }

    /**
     * Tell the server the size of a publication that changed without republishing, so a later
     * resolution change does not walk past the ceiling computed at publish time.
     */
    private async redeclareVideo(track: MediaStreamTrack): Promise<void> {
        const callId = this.callId;
        const video = videoIntentOf(track);
        if (!callId || !video) return;
        await firstValueFrom(this.voiceService.declareVideo(callId, video)).catch(() => void 0);
    }

    // ── Remote audio, onto the Rust mixer ─────────────────────────────────────

    /**
     * Pull a remote audio track into the Rust mixer. Audio must never be subscribed on this room:
     * Rust owns decode, AEC and per-source volume, and a second subscription plays the room twice.
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
        // in flight and the guard is what stops the second subscribing behind the first.
        this.subscribedAudioUserIds.add(userId);

        const session = await this.awaitSession();
        if (!session) {
            // Must be released, or the participant is permanently inaudible for the call.
            this.subscribedAudioUserIds.delete(userId);
            console.error('[call] dropped a subscribe, no session after waiting', {userId});
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
            // Roll the guard back. Every retry route is gated behind it, so leaving it consumed
            // makes one failure permanent.
            this.subscribedAudioUserIds.delete(userId);
            console.error('[call] audio subscribe failed', {userId, trackName}, e);
        }
    }

    /**
     * Pull a share's own sound into the Rust mixer, keyed by track name and never by user: muting
     * the stream must leave its author audible, which is why the `'audio'` branch cannot serve it.
     */
    private async subscribeScreenAudio(
        userId: string,
        remoteMediaSessionId: string,
        trackName: string,
    ): Promise<void> {
        if (this.remoteScreenAudioIds.get(userId) === trackName) return;

        const session = await this.awaitSession();
        if (!session) {
            console.error('[call] dropped a screen-audio subscribe, no session', {trackName});
            return;
        }

        try {
            await this.voiceEngine.subscribe(session, trackName, remoteMediaSessionId, trackName);
            this.remoteScreenAudioIds.set(userId, trackName);
            // A share that starts while its author is already muted must stay muted, or a restarted
            // share comes back at full volume.
            if (this.screenAudioMutedSignal().has(userId)) {
                await this.voiceEngine.setUserVolume(trackName, 0);
            } else {
                // Rust starts every source at unity, so the stored slider position must be
                // re-applied or a volume set before this track name existed is silently lost.
                const volume = this.screenVolumes.get(userId);
                if (volume !== undefined) await this.voiceEngine.setUserVolume(trackName, volume);
            }
        } catch (e) {
            console.error('[call] screen-audio subscribe failed', {userId, trackName}, e);
        }
    }

    /**
     * Unwind whatever share audio we hold for a participant who has gone. The mute flag must
     * survive: it is a preference about that person's streams, not about this track.
     */
    private dropScreenAudio(userId: string): void {
        const sourceId = this.remoteScreenAudioIds.get(userId);
        if (!sourceId) return;
        void this.dropSource(sourceId);
        this.remoteScreenAudioIds.delete(userId);
    }

    /**
     * Wait for this call's publication rather than dropping a subscribe that arrived before it:
     * listeners are set up before `voiceEngine.start()` resolves, so announcements for participants
     * already in the call land while `voiceSession` is still null and nothing else retries them.
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
     * holds, then hand the result to the UI. A diff, not a rebuild: rebuilding costs a keyframe per
     * tile and flickers the whole room whenever one person turns a camera on.
     */
    private reconcileVideo(tracks: ReadonlyMap<string, RemoteMediaTrack>): void {
        // Ownership guard, and it must be ownership rather than emptiness: this service and
        // `VoiceRTCService` are both root singletons sharing one `LiveKitRoomService`, so without
        // it this pass silently unsubscribes guild voice's tracks. An empty `wantedVideo` during a
        // live call still has to close what the roster dropped.
        if (!this.callId) return;

        const held = new Map<string, RemoteMediaTrack>();
        for (const track of tracks.values()) held.set(track.publication.trackName, track);

        // Runs over what the room reports, not over what we remember asking for, so a reconnect
        // that restored a broader subscription is also closed.
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
     * {@link RoomPublishing.publicationsOf} is the only bridge from name to sid for a publication
     * this room has not subscribed to. An unknown name is a race, not an error: counted and retried.
     */
    private subscribeVideo(trackName: string, want: WantedVideo): void {
        const sid = this.roomMedia
            .publicationsOf?.(want.userId)
            ?.find(p => p.trackName === trackName)?.trackSid;
        if (!sid) {
            this.unresolvedVideoSignal.update(n => n + 1);
            return;
        }
        this.livekit.setSubscribed(sid, true);
    }

    /**
     * The publish half of the room, or an empty object when the wrapper does not carry it.
     * See {@link RoomPublishing}. Warned once per session, not per call.
     */
    private get roomMedia(): Partial<RoomPublishing> {
        const room = this.livekit as unknown as Partial<RoomPublishing>;
        if (!this.warnedMissingRoomSurface && typeof room.publishTrack !== 'function') {
            this.warnedMissingRoomSurface = true;
            console.error(
                '[call] the room wrapper carries no publish/publications surface: ' +
                    'cameras and shares cannot be published and roster rows cannot be resolved to track sids',
            );
        }
        return room;
    }

    /**
     * Hand the room's video to the UI, and take back what has gone. Departures must run first, or a
     * share that restarted under a new name is torn down again by the departure of its predecessor.
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

            // `describeTrack` is the only thing that decides what a track name means: it tests
            // `screen-audio-` before `screen-`, or a share's audio reads as its video.
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
            this.attachedVideo.set(name, {
                userId: track.userId,
                kind: kind === 'video' ? 'video' : 'screen',
                shareId,
            });
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

    /** Everything this user was publishing, gone at once: a departure or an eviction. */
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

    /** 1s while a stats panel is open, 2s otherwise. See the twin on `VoiceRTCService`. */
    private armStatsInterval(): void {
        clearInterval(this.statsInterval);
        const period = this.inspected() ? 1000 : 2000;
        this.statsInterval = setInterval(() => void this.pollStats(), period);
    }

    /**
     * Stop polling and forget everything the poll produced. `inspected` must be cleared here: this
     * service is root-provided, and an inspection left set pins every later call at the 1s cadence.
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
     * Every subscribed video receiver's statistics, merged, plus the mid to owner map. The map must
     * be built in the same pass that collects the stats, or a track that appeared between two reads
     * lands in one and not the other.
     */
    private async inboundReport(): Promise<{
        report: StatsLike;
        owners: ReadonlyMap<string, InboundTrackOwner>;
    }> {
        const stats: RTCStats[] = [];
        const owners = new Map<string, InboundTrackOwner>();

        for (const held of this.livekit.remoteTracks().values()) {
            const {kind, shareId} = describeTrack(held.publication.trackName);
            // Audio of either kind belongs to the Rust room and is never subscribed here.
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

        // `framesPerSecond` arrives pre-computed, so this needs no second sample, unlike the kbps
        // accounting below.
        this.inboundVideoFpsByShareSignal.set(inboundScreenFpsByShare(report, owners));
        // One extra pass over reports that were fetched anyway, and only while a panel is open.
        const inspectedSnapshot = detailedStatsForShare(report, owners, this.inspected()?.shareId ?? null);
        this.inspectedStats.set(this.withMeasuredBitrate(inspectedSnapshot));

        let inAudio = 0,
            inVideo = 0,
            packetsLost = 0;
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
        const kbps = (cur: number, prev: number) => Math.max(0, Math.round(((cur - prev) * 8) / dt / 1000));

        this.stats.set({
            inboundKbps: kbps(inAudio + inVideo, this.prevBytes.inAudio + this.prevBytes.inVideo),
            inboundAudioKbps: kbps(inAudio, this.prevBytes.inAudio),
            inboundVideoKbps: kbps(inVideo, this.prevBytes.inVideo),
            // Zero is the honest reading, not a stub: this room only receives, and what this client
            // sends leaves on the Rust connection, counted by `RustMediaService.pollOutbound`.
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
     * The first poll produces no rate at all rather than zero, so the row is absent for one tick
     * instead of claiming the stream is silent. Twin of `VoiceRTCService.withMeasuredBitrate`.
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
     * Checks the ring lifecycle and reconciles media against the room snapshot. Two reads, and both
     * are needed: `getCall` carries the ring state and no media handles, `getCallSnapshot` carries
     * who is pullable and which screen-share tracks are live.
     */
    private async syncParticipants(): Promise<void> {
        const callId = this.callId;
        if (!callId) return;

        let fresh: CallDto;
        try {
            fresh = await firstValueFrom(this.voiceService.getCall(callId));
        } catch {
            return; // Best-effort; a later reconnect or live event will catch up.
        }
        if (this.callId !== callId) return; // Call ended/changed while the request was in flight

        const s = this.callSession.session();
        if (!s) return;
        const ownId = s.participants.find(p => p.isLocal)?.userId;

        // Must go through the normaliser, never compared raw: the field reaches us as `"Completed"`
        // or as the ordinal depending on the serialising host's JsonStringEnumConverter.
        const freshStatus = callStatusName(fresh.status);
        if (freshStatus === 'Completed' || freshStatus === 'Rejected') {
            this.callSession.end();
            return;
        }
        // Only act once `ownId` is known: it is unresolved when `ownProfile()` had not loaded at
        // join time, and "no participant matches undefined" would hang up a healthy call.
        if (ownId && !fresh.participants.some(p => p.userId === ownId)) {
            this.callSession.end();
            return;
        }

        await this.refetchSnapshot();
    }

    /** Decide what an arriving event means, and act on it. */
    private gate(event: VoiceEventEnvelope, apply: () => void): void {
        this.decide(apply, () => this.tracker.receive(event));
    }

    /** The same, for relay events: applied without advancing the version. */
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

    /** Read the room's authoritative state again. Best-effort; the next heartbeat repairs a miss. */
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

    /** Take the snapshot and reconcile media against it: one read restores every subscription. */
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

        // Cameras must be carried over, not rebuilt: the snapshot lists no camera tracks, so a
        // camera is known only from `TrackPublished` and a rebuild drops it on every refetch.
        for (const [name, want] of [...this.wantedVideo]) {
            if (want.kind !== 'video' || !present.has(want.userId)) this.wantedVideo.delete(name);
        }

        for (const p of snapshot.participants) {
            if (p.userId === ownId) continue;
            this.callSession.onParticipantJoined(p.userId);
            // A roster row alone is not an invitation to subscribe: `Joined` means a connection
            // exists and a microphone track does not, and only `publishState` decides that. The
            // desktop client sends an EMPTY STRING `mediaSessionId`, which is legitimate and must
            // never be read as "not publishing".
            if (p.publishState !== 'Publishing' || !p.audioTrackName) continue;

            void this.subscribeToTrack(p.userId, p.mediaSessionId ?? '', p.audioTrackName, 'audio');

            for (const share of p.shares) {
                // A null share identity does not mean unpullable: desktop publishes shares on the
                // participant's own identity, so only a client that splits them sets the field.
                const shareIdentity = share.mediaSessionId ?? p.mediaSessionId ?? '';

                for (const trackName of share.trackNames) {
                    const {kind} = describeTrack(trackName);
                    // Both halves, each on its own transport: the video onto this room, the audio
                    // onto the Rust mixer where the volume and mute controls live.
                    if (kind === 'screenAudio') {
                        void this.subscribeToTrack(p.userId, shareIdentity, trackName, 'screenAudio');
                    } else {
                        this.wantedVideo.set(trackName, {
                            userId: p.userId,
                            kind: 'screen',
                            shareId: share.shareId,
                        });
                    }
                }
            }
        }

        this.reconcileVideo(this.livekit.remoteTracks());
    }

    /**
     * "You are behind", or on `roomGone`, "this call is over". Must not be version-gated: a resync
     * is an instruction, and `roomGone` carries version zero, which the tracker reads as stale.
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
            // The Rust publication's identity, never this room's: asserting `{userId}#view` hands
            // peers an identity with no audio track. The empty string the Rust engine answers with
            // is legitimate and must be passed through, not collapsed to null; only an absent
            // `voiceSession` means not publishing.
            mediaSessionId: this.voiceSession ? this.voiceSession.mediaSessionId : null,
            audioTrackName: this.voiceSession ? this.voiceSession.trackName : null,
        });
    }

    // ── SignalR event listeners ───────────────────────────────────────────────

    private setupWsListeners(): void {
        this.wsSubs = [
            // Someone joined: add to UI and pull their audio onto the Rust mixer.
            this.voiceWs.participantJoinedObservable.subscribe(e =>
                this.gate(e, () => {
                    this.callSession.onParticipantJoined(e.userId);
                    // Our own announcement reaches us too; pulling our own microphone back would put us
                    // in the mix twice.
                    const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                    if (e.userId === localId) return;
                    void this.subscribeToTrack(e.userId, e.mediaSessionId, e.audioTrackName, 'audio');
                }),
            ),

            // New video / screen track published: want it.
            this.voiceWs.trackPublishedObservable.subscribe(e =>
                this.gate(e, () => {
                    const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                    if (e.userId === localId) return; // Skip own tracks
                    if (e.kind === 'video') {
                        this.wantVideo(e.trackName, {userId: e.userId, kind: 'video', shareId: null});
                    } else if (e.kind === 'screen') {
                        this.wantVideo(e.trackName, {
                            userId: e.userId,
                            kind: 'screen',
                            shareId: e.shareId ?? null,
                        });
                    } else if (e.kind === 'screenAudio') {
                        void this.subscribeToTrack(e.userId, e.mediaSessionId, e.trackName, 'screenAudio');
                    }
                }),
            ),

            // Authoritative state, pushed on join, on publish, and whenever the server decides we
            // are out of date. Applied wholesale; it is not a delta.
            this.voiceWs.voiceSnapshotObservable.subscribe(s => this.applySnapshot(s)),
            this.voiceWs.voiceResyncObservable.subscribe(e => {
                if (e.callId === this.callId) this.onResync(e.reason);
            }),

            // A track stopped.
            this.voiceWs.trackClosedObservable.subscribe(e =>
                this.gate(e, () => {
                    const {kind, shareId} = describeTrack(e.trackName);
                    if (kind === 'screenAudio') {
                        // Must be dropped, or a stopped share keeps its mixer slot forever: silent, but
                        // still popped and mixed on every frame.
                        void this.dropSource(e.trackName);
                        this.remoteScreenAudioIds.delete(e.userId);
                        return;
                    }
                    // Both, and the overlap is required: a close for a track this room never held
                    // reconciles to nothing, so the tile is cleared here too. Every step is idempotent.
                    this.dropVideo(e.trackName);
                    if (kind === 'screen' && shareId) this.callSession.onScreenShareStopped(shareId);
                    else if (kind === 'video') this.callSession.onCameraChanged(e.userId, false);
                }),
            ),

            // Remote mute/speaking/camera state changes
            this.voiceWs.muteChangedObservable.subscribe(e =>
                this.gate(e, () => this.callSession.onMuteChanged(e.userId, e.isMuted)),
            ),

            // Relay, and the highest-frequency one there is: applied without advancing the version
            // and without gap detection, so an unsynchronised room does not refetch at speaking rate.
            this.voiceWs.speakingChangedObservable.subscribe(e =>
                this.gateRelay(e, () => this.callSession.onSpeakingChanged(e.userId, e.isSpeaking)),
            ),

            // Relay: not stored server-side, not versioned. See VoiceRoomTracker.receiveRelay.
            this.voiceWs.cameraChangedObservable.subscribe(e =>
                this.gateRelay(e, () => {
                    // Turn-off: update the UI immediately. Turn-on is handled by TrackPublished, which
                    // is what carries the track name there is nothing to pull without.
                    if (!e.isCameraOn) this.callSession.onCameraChanged(e.userId, false);
                }),
            ),

            // Screen share start: surface in the UI immediately, before any media arrives.
            this.voiceWs.screenShareStartedObservable.subscribe(e =>
                this.gate(e, () => {
                    this.callSession.onScreenShareStarted(e.shareId, e.userId, undefined);
                }),
            ),

            this.voiceWs.screenShareStoppedObservable.subscribe(e =>
                this.gate(e, () => this.callSession.onScreenShareStopped(e.shareId)),
            ),

            // Someone left: drop them from the UI and unwind everything we hold for them. The only
            // departure event the contract carries. Every step is idempotent, so the overlap with
            // `syncParticipants` is harmless.
            this.voiceWs.callParticipantLeftObservable.subscribe(e => {
                // Teardown must be guarded on the room id: every step below is keyed on user, so a
                // departure from another call silently drops that user's media out of this one.
                if (e.callId !== this.callId) return;
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

            // The call ended for someone else's reason; the server has already torn it down.
            this.voiceWs.callEndedObservable.subscribe(e => {
                // `wasActive` keeps a self-initiated hangup silent: hanging up nulls session()
                // synchronously, before any CallEnded broadcast can arrive.
                const wasActive = !!this.callSession.session();
                this.callSession.end(true);
                if (wasActive) this.toast.info(describeCallEndedReason(e.reason));
            }),
        ];
    }
}
