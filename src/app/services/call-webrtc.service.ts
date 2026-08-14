import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {firstValueFrom, Subscription} from 'rxjs';
import {OAuthService} from 'angular-oauth2-oidc';
import {describeEntitlementDenial} from '../core/entitlement-message';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {VoiceEngineService, VoiceSession} from './voice-engine.service';
import {CallSessionService} from './call-session.service';
import {CfTrackNew, CfTrackResult, VoiceService} from './voice.service';
import {
    callStatusName,
    ConnectionState,
    describeCallEndedReason,
    VoiceWebsocketService,
} from './voice-websocket.service';
import {ToastService} from './toast.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import type {CallDto} from '../dtos/response/call.dto';
import {
    describeTrack,
    isStaleSubscription,
    VoiceEventDecision,
    VoiceEventEnvelope,
    VoiceRoomSnapshot,
    VoiceRoomTracker,
} from '../models/voice-room';
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';
import {
    applyScreenEncoding,
    applySimpleBitrate,
    CAMERA_KBPS,
    preferVideoCodecs,
} from './webrtc-encoding';
import {SUBSCRIBE_RETRY_DELAYS_MS} from './voice-rtc.service';
import {inboundScreenFpsByShare} from '../shared/call/inbound-fps';

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
 * Manages the full WebRTC lifecycle for a Cloudflare Calls SFU session.
 *
 * Architecture:
 *   - One RTCPeerConnection per call (SFU model -all media goes through CF).
 *   - CallSessionService owns the UI state; this service owns the WebRTC plumbing.
 *   - Effects watch the session signal to connect/disconnect and apply local state
 *     changes (mute, camera, screen share) to the peer connection.
 *   - SignalR events (via VoiceWebsocketService) drive remote participant state.
 *
 * The media surface is backend-neutral - no SFU vocabulary reaches this client. Sessions carry a
 * `mediaSessionId` and declare their `backend`; publish and subscribe share one `POST .../tracks`
 * and are told apart by each track's `direction`.
 */
@Injectable({providedIn: 'root'})
export class CallWebRtcService {
    // ── Stats polling ────────────────────────────────────────────────────────
    readonly stats = signal<CallStats | null>(null);
    /**
     * Remote screen shares' arriving frame rate, by share id - see `inboundScreenFpsByShare` for how
     * this is read off the same `getStats()` report {@link stats} comes from, and
     * `CallScreenShare.inboundFps` for why a share missing from this map must render as "no data"
     * rather than 0.
     *
     * <p>Keyed by share id, not user id: `CallSessionService.onScreenShareStarted` dedupes incoming
     * shares by `shareId` alone, so a stale share can briefly sit in the model alongside its
     * replacement under the same `userId` (a rapid stop/restart race). Keying this by user would
     * make one of the two silently report the other's number.</p>
     */
    private readonly inboundVideoFpsByShareSignal = signal<Record<string, number>>({});
    readonly inboundVideoFpsByShare = this.inboundVideoFpsByShareSignal.asReadonly();
    // ── Connection state ──────────────────────────────────────────────────────
    private readonly pcState = signal<RTCPeerConnectionState>('new');
    private readonly engineUp = signal(false);

    /**
     * What the call UI shows as the connection state.
     *
     * This peer connection only receives now, so until the other side publishes there is nothing to
     * negotiate and it sits in `'new'` - which the call panel reads as "connecting" and would never
     * leave. Whether your voice is going out is the Rust engine's business; once the connection has
     * something to do, its own state takes over again, including its failures.
     */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const pc = this.pcState();
        return pc === 'new' && this.engineUp() ? 'connected' : pc;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    private callSession = inject(CallSessionService);

    /**
     * Narrow views of the session, so effects wake on the value they care about rather than on
     * every rebuild of the session object. A `computed` over a boolean only notifies when the
     * boolean actually flips.
     */
    private readonly localMuted = computed(() => this.callSession.session()?.local.isMuted ?? false);
    private readonly localDeafened = computed(() => this.callSession.session()?.local.isDeafened ?? false);
    private voiceService = inject(VoiceService);
    private voiceWs = inject(VoiceWebsocketService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private screenPicker = inject(ScreenPickerService);
    private voiceEngine = inject(VoiceEngineService);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private oauth = inject(OAuthService);
    // ── WebRTC state ─────────────────────────────────────────────────────────
    private pc: RTCPeerConnection | null = null;
    private mediaSessionId: string | null = null;
    private callId: string | null = null;
    /**
     * The Rust publication carrying this call's audio.
     *
     * Held rather than looked up, because the engine now runs several calls at once and every
     * command has to say which one it means. Isle proximity voice holds its own alongside this.
     */
    private voiceSession: VoiceSession | null = null;
    private videoSender: RTCRtpSender | null = null;
    private videoTrackName: string | null = null;
    private screenSender: RTCRtpSender | null = null;
    private screenTrackName: string | null = null;
    private screenShareId: string | null = null;
    // MID → { userId, kind, shareId } -used to route ontrack events
    private readonly midMap = new Map<string, {
        userId: string;
        kind: 'audio' | 'video' | 'screen';
        shareId?: string
    }>();
    // Users already subscribed to for audio -makes subscribeToTrack('audio')
    // safe to call more than once for the same user (the live ParticipantJoined
    // event and a reconcile-on-reconnect backfill can race for the same user).
    private readonly subscribedAudioUserIds = new Set<string>();
    // userId → the mixer source id of their share's audio, so the per-stream mute can find it.
    //
    // Keyed by *track name* rather than user id in the mixer, because a share's audio and its
    // author's voice are separate sources - muting the stream must not mute the person sharing it.
    private readonly remoteScreenAudioIds = new Map<string, string>();
    private readonly screenAudioMutedSignal = signal<Set<string>>(new Set());
    readonly screenAudioMuted = this.screenAudioMutedSignal.asReadonly();
    // Remote video/screen track name → the session it is pulled from, and whose it is.
    //
    // The audio path has had a dedupe guard all along; video never did, because the only route to it
    // was the live TrackPublished event. The snapshot backfill covers the same tracks, so without
    // this a viewer present when a share starts subscribes twice and leaks a transceiver per
    // snapshot. A *different* session id for the same name is a republish and a real resubscribe.
    private readonly subscribedVideoTracks = new Map<string, { mediaSessionId: string; userId: string }>();
    /**
     * `instanceId` and `version` for this call, and the decision procedure for every event about
     * it. See {@link VoiceRoomTracker}.
     */
    private readonly tracker = new VoiceRoomTracker();
    private refetchInFlight = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private prevConnState: ConnectionState | null = null;
    // Per-user volume overrides (0–1.0), persisted for the call duration
    private readonly userVolumes = new Map<string, number>();
    // Per-share volume overrides (0–1.0), persisted for the call duration.
    //
    // Deliberately its own map rather than reusing userVolumes: a stream's audio is a different
    // mixer source than its author's voice (see remoteScreenAudioIds), and the two have to be
    // adjustable independently - the same reason mute is keyed on the track rather than the user.
    private readonly screenVolumes = new Map<string, number>();
    // ontrack events that arrived before their midMap entry was written -replayed after subscribe completes
    private readonly pendingTracks: RTCTrackEvent[] = [];

    // ── Negotiation serialisation ────────────────────────────────────────────
    // RTCPeerConnection only allows one offer/answer exchange at a time. Queuing
    // ensures publishAudioTrack and any concurrent subscribeToTrack calls never
    // ── Prev-state for change detection inside effects ───────────────────────
    private prevMuted = false;
    private prevCameraOn = false;
    private prevSharing = false;
    // race on setLocalDescription / setRemoteDescription.
    private negotiationChain: Promise<unknown> = Promise.resolve();
    // ── RxJS subscriptions to WS observables ────────────────────────────────
    private wsSubs: Subscription[] = [];
    private statsInterval?: ReturnType<typeof setInterval>;
    private prevBytes = {inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0};
    private prevStatsTs = 0;

    constructor() {
        // CallSessionService owns the preset (it also drives capture); re-apply the sender encoding
        // whenever the user changes quality mid-share.
        effect(() => {
            const preset = this.callSession.screenPreset();
            if (preset && this.screenSender) void applyScreenEncoding(this.screenSender, preset);
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

        // A reconnect is the signal that any `call.*` events broadcast during
        // the gap were dropped -SignalR doesn't queue undelivered messages.
        // Re-sync authoritative state so a missed ParticipantJoined/CallEnded
        // doesn't leave us permanently out of sync.
        effect(() => {
            const cs = this.voiceWs.connectionState();
            const wasConnected = this.prevConnState === ConnectionState.Connected;
            this.prevConnState = cs;
            if (cs === ConnectionState.Connected && !wasConnected && this.callId) {
                // Asserted immediately rather than at the next tick of the 30-second timer. A
                // disconnect shortens our liveness window server-side, and the heartbeat is what
                // restores it - and what pulls back a Snapshot if we fell behind while away.
                //
                // Nothing here rebuilds media. The peer connection and the media session ride their
                // own transport and a hub blip says nothing about them; tearing them down on one
                // spends the session id and earns `sessionGone` on every call after it.
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

        // Apply local deafen state to every remote audio element's volume - mirrors
        // VoiceRTCService.setDeafened for the guild path. Narrowed to `localDeafened` for the same
        // reason as the mute effect above.
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

        // Publish or unpublish the screen share track.
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
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────

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

    // ── SDP offer/answer cycle ────────────────────────────────────────────────

    // Serialise all SDP exchanges through a promise chain so concurrent publish

    /**
     * Open the media session for a call.
     *
     * <p>Driven from an effect as `void this.connect(...)`, so nothing is holding the promise and a
     * rejection here has no call site to land at. It used to be unguarded: a refused session -
     * offline SFU, a revoked call, an entitlement rejection - surfaced as an unhandled rejection in
     * the console and left `callId` set, which blocks every later attempt because that field is the
     * re-entry guard. The catch tears the half-built connection down so the next attempt can run,
     * and says something, because a call that is silently not connected looks exactly like one that
     * is.</p>
     */
    private async connect(callId: string): Promise<void> {
        this.callId = callId; // Set immediately so re-entry is prevented

        // CF Calls SFU has a publicly routable server -no STUN/TURN needed.
        // bundlePolicy: 'max-bundle' is required by Cloudflare Calls.
        this.pc = new RTCPeerConnection({bundlePolicy: 'max-bundle'});
        (window as any).__pc = this.pc;  // ← add this line
        this.pc.ontrack = (e) => this.handleRemoteTrack(e);
        this.pc.onconnectionstatechange = () => {
            if (this.pc) this.pcState.set(this.pc.connectionState);
        };

        try {
            await this.openSession(callId);
        } catch (err) {
            console.error('[WebRTC] call session setup failed', err);
            this.disconnect();
            const denial = describeEntitlementDenial(err);
            this.toast.error(this.translate.instant(denial?.messageKey ?? 'CALL.CONNECT_FAILED'));
        }
    }

    private async openSession(callId: string): Promise<void> {
        const {mediaSessionId} = await firstValueFrom(this.voiceService.cfCreateSession(callId, false));
        if (!this.callId) return;
        this.mediaSessionId = mediaSessionId;

        // Set up WS listeners NOW -mediaSessionId is ready and we need to be subscribed before the
        // Rust session's publish triggers ExchangeParticipantJoined on the server, which sends
        // ParticipantJoined back to us for any already-connected participants.
        this.setupWsListeners();

        // Backfill in case that ExchangeParticipantJoined re-notify is ever missed (e.g.
        // joining a group call already in progress right as a signaling gap opens) -
        // subscribeToTrack's dedupe guard makes this safe to race with the WS listener.
        void this.syncParticipants();

        // The microphone is captured, processed and published entirely in Rust, on its own
        // Cloudflare session opened with primary=true. Nothing is added to this peer connection;
        // the other side resolves the track from the ParticipantJoined event the backend emits when
        // that session publishes "audio", and it carries the Rust session id.
        try {
            this.voiceSession = await this.voiceEngine.start(
                {kind: 'call', callId},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
                await this.deviceIdentity.deviceId(),
            );
        } catch (e) {
            console.error('[WebRTC] Rust voice engine failed to start -joining without audio', e);
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
        // join arrives before the peer connection and the Rust session exist, so its screen shares
        // would otherwise be dropped on the floor - the same ordering trap the guild path has.
        void this.refetchSnapshot();

        // Liveness *and* repair: this is what lets the server correct its record of what we are
        // publishing and re-announce it to peers. The call path has never sent one.
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30_000);

        this.startStatsPolling();
    }

    /** Open or close the microphone for this call, leaving any other call's routing alone. */
    private setPttOpen(open: boolean): void {
        if (this.voiceSession) void this.voiceEngine.setPttOpen(this.voiceSession, open);
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
            console.error('[WebRTC] dropped a screen-audio subscribe - no session', {trackName});
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
            if (isStaleSubscription(e)) {
                console.warn('[WebRTC] screen-audio subscribe refused as stale, refetching', {trackName});
                void this.refetchSnapshot();
                return;
            }
            console.error('[WebRTC] screen-audio subscribe failed', {userId, trackName}, e);
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

    /**
     * Wait for this call's publication to exist, rather than dropping a subscribe that arrived
     * before it.
     *
     * <p>The server announces every publisher the moment a session is created, and this client
     * creates its session and sets up its listeners *before* `voiceEngine.start()` resolves - so
     * every participant already in the call is announced while `voiceSession` is still null. The
     * snapshot refetch after connect covers most of it, but an announcement landing inside that
     * window has nothing to retry it. Bounded by the same schedule a subscribe retries on, because
     * a connect that has not produced a session in that long is not going to.</p>
     *
     * <p>Ported from the guild path, which has had this since the Rust engine landed.</p>
     */
    private async awaitSession(): Promise<VoiceSession | null> {
        if (this.voiceSession) return this.voiceSession;
        for (const delay of SUBSCRIBE_RETRY_DELAYS_MS) {
            await new Promise(r => setTimeout(r, delay));
            if (this.voiceSession) return this.voiceSession;
        }
        return this.voiceSession;
    }

    /** Drop a source from this call's publication. Null-safe: WS events outlive the call. */
    private async dropSource(id: string): Promise<void> {
        if (this.voiceSession) await this.voiceEngine.unsubscribe(this.voiceSession, id);
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
        this.pc?.close();
        this.wsSubs.forEach(s => s.unsubscribe());

        this.pcState.set('new');
        this.participantsWithAudio.set(new Set());
        this.pc = null;
        this.mediaSessionId = null;
        this.callId = null;
        this.videoSender = null;
        this.videoTrackName = null;
        this.screenSender = null;
        this.screenTrackName = null;
        this.screenShareId = null;
        this.midMap.clear();
        this.userVolumes.clear();
        this.screenVolumes.clear();
        this.subscribedAudioUserIds.clear();
        this.subscribedVideoTracks.clear();
        this.remoteScreenAudioIds.clear();
        this.screenAudioMutedSignal.set(new Set());
        this.pendingTracks.length = 0;
        this.negotiationChain = Promise.resolve();
        this.wsSubs = [];
        this.prevMuted = false;
        this.prevCameraOn = false;
        this.prevSharing = false;
    }

    // ── Local track publishing ────────────────────────────────────────────────

    // and subscribe calls never race on setLocalDescription/setRemoteDescription.
    private offerAnswerCycle(buildTracks: () => CfTrackNew[]): Promise<CfTrackResult[]> {
        const next = this.negotiationChain
            .catch(() => void 0)
            .then(() => this.doOfferAnswer(buildTracks));
        this.negotiationChain = next.catch(() => void 0);
        return next;
    }

    private async doOfferAnswer(buildTracks: () => CfTrackNew[]): Promise<CfTrackResult[]> {
        if (!this.pc || !this.mediaSessionId || !this.callId) return [];

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        if (!this.callId) return [];

        const response = await firstValueFrom(
            this.voiceService.cfTracksNew(this.callId, this.mediaSessionId, {
                sessionDescription: offer,
                tracks: buildTracks(),
            })
        );
        if (!this.callId) return [];

        await this.setRemoteDescriptionOrThrow(response.sessionDescription, 'tracks/new');

        if (response.requiresImmediateRenegotiation) {
            // CF needs a fresh offer now that it has set up the remote tracks
            const reOffer = await this.pc.createOffer();
            await this.pc.setLocalDescription(reOffer);
            if (!this.callId) return [];

            const renegResponse = await firstValueFrom(
                this.voiceService.cfRenegotiate(this.callId, this.mediaSessionId, reOffer)
            );
            if (!this.callId) return [];
            await this.setRemoteDescriptionOrThrow(renegResponse.sessionDescription, 'renegotiate');
        }

        return response.tracks ?? [];
    }

    /**
     * setRemoteDescription with the sessionDescription's content logged on failure.
     * That description comes verbatim from the backend's Cloudflare Calls proxy, not
     * from this client, so a parse failure here means the backend/CF response was
     * malformed before it ever reached us -there is nothing to munge or retry
     * client-side. This only makes the next occurrence diagnosable instead of
     * surfacing as a bare browser-internal parse error.
     */
    private async setRemoteDescriptionOrThrow(desc: RTCSessionDescriptionInit, stage: string): Promise<void> {
        if (!this.pc) return;
        try {
            await this.pc.setRemoteDescription(desc);
        } catch (e) {
            console.error(`[WebRTC] setRemoteDescription failed at ${stage}:`, e, {
                type: desc?.type,
                sdpLength: desc?.sdp?.length ?? 0,
                sdpPreview: desc?.sdp?.slice(0, 500),
            });
            throw e;
        }
    }

    private async publishVideoTrack(stream: MediaStream): Promise<void> {
        if (!this.pc || !this.callId) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        const transceiver = this.pc.addTransceiver(track, {direction: 'sendonly'});
        const results = await this.offerAnswerCycle(() => [{
            direction: 'publish',
            mid: transceiver.mid ?? '0',
            trackName: 'video',
        }]);
        this.videoSender = transceiver.sender;
        this.videoTrackName = results[0]?.trackName ?? 'video';
        await applySimpleBitrate(transceiver.sender, CAMERA_KBPS);
        if (this.callId) this.voiceWs.invokeCameraChanged(this.callId, true);
    }

    private async unpublishVideoTrack(): Promise<void> {
        if (!this.pc || !this.callId) return;
        const trackName = this.videoTrackName ?? 'video';
        if (this.videoSender) {
            this.pc.removeTrack(this.videoSender);
            this.videoSender = null;
        }
        this.videoTrackName = null;

        if (this.mediaSessionId) {
            await firstValueFrom(
                this.voiceService.cfCloseTracks(this.callId, this.mediaSessionId, [trackName])
            ).catch(() => void 0);
        }
        if (this.callId) this.voiceWs.invokeCameraChanged(this.callId, false);
    }

    // ── Remote track subscription ─────────────────────────────────────────────

    private async publishScreenTrack(shareId: string, stream: MediaStream): Promise<void> {
        if (!this.pc || !this.callId) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        const transceiver = this.pc.addTransceiver(track, {direction: 'sendonly'});

        // Prefer VP9 for screen sharing -better quality-per-bit means higher effective fps
        // at the same bitrate compared to VP8.
        preferVideoCodecs(transceiver, 'sender');

        const cfTrackName = `screen-${shareId}`;
        const results = await this.offerAnswerCycle(() => [{
            direction: 'publish',
            mid: transceiver.mid ?? '0',
            trackName: cfTrackName,
        }]);
        this.screenSender = transceiver.sender;
        this.screenTrackName = results[0]?.trackName ?? cfTrackName;
        this.screenShareId = shareId;
        await applyScreenEncoding(transceiver.sender, this.callSession.screenPreset() ?? DEFAULT_STREAM_PRESET);
        if (this.callId) this.voiceWs.invokeScreenShareStarted(this.callId, shareId);
    }

    private async unpublishScreenTrack(): Promise<void> {
        if (!this.pc || !this.callId) return;
        const trackName = this.screenTrackName ?? '';
        const shareId = this.screenShareId ?? '';
        if (this.screenSender) {
            this.pc.removeTrack(this.screenSender);
            this.screenSender = null;
        }
        this.screenTrackName = null;
        this.screenShareId = null;

        if (this.mediaSessionId && trackName) {
            await firstValueFrom(
                this.voiceService.cfCloseTracks(this.callId, this.mediaSessionId, [trackName])
            ).catch(() => void 0);
        }
        if (shareId && this.callId) this.voiceWs.invokeScreenShareStopped(this.callId, shareId);
    }

    // ── Remote track routing ──────────────────────────────────────────────────

    private async subscribeToTrack(
        userId: string,
        remoteMediaSessionId: string,
        trackName: string,
        kind: 'audio' | 'video' | 'screen' | 'screenAudio',
        shareId?: string,
    ): Promise<void> {
        if (kind === 'screenAudio') {
            await this.subscribeScreenAudio(userId, remoteMediaSessionId, trackName);
            return;
        }
        if (kind === 'audio') {
            if (this.subscribedAudioUserIds.has(userId)) return;
            // Claimed before the wait below, not after: two announcements for the same user can
            // both be in flight, and the guard is the only thing stopping the second from
            // subscribing again behind the first.
            this.subscribedAudioUserIds.add(userId);

            const session = await this.awaitSession();
            if (!session) {
                // Released, so a later announcement or the next snapshot can retry. This used to
                // return silently while still holding the guard, which made the participant
                // permanently inaudible for the call.
                this.subscribedAudioUserIds.delete(userId);
                console.error('[WebRTC] dropped a subscribe - no session after waiting', {userId});
                return;
            }

            // Audio never touches this peer connection now: it is pulled onto the Rust session,
            // decoded and mixed there, and played through the output device Rust owns.
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
                // Roll the guard back, exactly as the video path does below: every retry route -
                // live ParticipantJoined, the syncParticipants backfill, the reconnect resync - is
                // gated behind it, so leaving it consumed makes one failure permanent.
                this.subscribedAudioUserIds.delete(userId);
                if (isStaleSubscription(e)) {
                    // Gone, not late. Refetch and reconcile; retrying the same body cannot succeed.
                    console.warn('[WebRTC] audio subscribe refused as stale, refetching', {userId});
                    void this.refetchSnapshot();
                    return;
                }
                console.error('[WebRTC] audio subscribe failed', {userId, trackName}, e);
            }
            return;
        }
        if (!this.pc) return;
        // Same dedupe reasoning as the audio guard above, keyed on (track, publishing session) so a
        // republish on a new session still resubscribes. Claimed only on success, below.
        if (this.subscribedVideoTracks.get(trackName)?.mediaSessionId === remoteMediaSessionId) return;
        // Everything below is a network round trip (or more than one, via CF
        // renegotiation) that can throw or transiently fail -most likely on a cold
        // app start (fresh CF session, cold DNS/TLS). If we don't roll back the
        // dedupe guard above on failure, this user's audio is silently dead for
        // the rest of the call: every other path that could retry (live
        // ParticipantJoined, syncParticipants backfill, reconnect resync) is
        // gated behind the same subscribedAudioUserIds check, so a single failed
        // attempt here would have zero chance of ever being retried.
        try {
            console.log('[WebRTC] subscribeToTrack', {userId, remoteMediaSessionId, trackName, kind});
            // Only video reaches this connection now; audio returned above.
            const transceiver = this.pc.addTransceiver('video', {direction: 'recvonly'});
            preferVideoCodecs(transceiver, 'receiver');

            const results = await this.offerAnswerCycle(() => [{
                direction: 'subscribe',
                mediaSessionId: remoteMediaSessionId,
                trackName,
            }]);
            console.log('[WebRTC] subscribeToTrack results', results);

            // Only Cloudflare's own mid can route this track. Falling back to `transceiver.mid`
            // (as this used to) invents a mid for a subscription Cloudflare never set up: the
            // entry goes into midMap, no media ever arrives on it, and because the dedupe guard
            // above is left consumed, the live ParticipantJoined / syncParticipants / reconnect
            // resync paths that could retry are all short-circuited. That is the "No audio
            // received from this participant" state, and it lasted the whole call.
            const mid = results.find(r => r.trackName === trackName)?.mid;
            if (!mid) {
                throw new Error(
                    `Cloudflare returned no mid for ${kind} track "${trackName}" on session ${remoteMediaSessionId}`);
            }
            console.log('[WebRTC] midMap set', mid, '→', {userId, kind});
            this.midMap.set(mid, {userId, kind, shareId});
            // Recorded only once it worked, for the same reason the audio guard is rolled back on
            // failure: claiming it early would make every later retry skip the one thing that could
            // have recovered the track.
            this.subscribedVideoTracks.set(trackName, {mediaSessionId: remoteMediaSessionId, userId});
            this.processPendingTracks();
        } catch (e) {
            if (isStaleSubscription(e)) {
                // The share stopped between the announcement and this request. Nothing was recorded
                // in subscribedVideoTracks - that happens only on success - so a reconcile after the
                // refetch can subscribe cleanly if it comes back.
                console.warn('[WebRTC] subscribe refused as stale, refetching', {trackName});
                void this.refetchSnapshot();
                return;
            }
            console.error('[WebRTC] subscribeToTrack failed', {userId, trackName, kind}, e);
        }
    }

    // ── Per-user volume control ───────────────────────────────────────────────

    private processPendingTracks(): void {
        const remaining: RTCTrackEvent[] = [];
        for (const event of this.pendingTracks) {
            const mid = event.transceiver.mid;
            if (mid && this.midMap.has(mid)) {
                this.handleRemoteTrack(event);
            } else {
                remaining.push(event);
            }
        }
        this.pendingTracks.length = 0;
        this.pendingTracks.push(...remaining);
    }

    private handleRemoteTrack(event: RTCTrackEvent): void {
        const mid = event.transceiver.mid;
        console.log('[WebRTC] ontrack', {mid, kind: event.track.kind, midMapKeys: [...this.midMap.keys()]});
        if (!mid) return;
        const info = this.midMap.get(mid);
        if (!info) {
            this.pendingTracks.push(event);
            return;
        }

        const stream = event.streams[0] ?? new MediaStream([event.track]);

        // No audio branch: audio is mixed and played in Rust, and never routed here.
        if (info.kind === 'video') {
            this.callSession.onCameraChanged(info.userId, true, stream);
            event.track.onended = () => this.callSession.onCameraChanged(info.userId, false);
        } else if (info.kind === 'screen' && info.shareId) {
            this.callSession.onScreenShareStarted(info.shareId, info.userId, stream);
            event.track.onended = () => this.callSession.onScreenShareStopped(info.shareId!);
        }
    }

    // ── Stats polling ─────────────────────────────────────────────────────────

    private startStatsPolling(): void {
        this.prevBytes = {inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0};
        this.prevStatsTs = 0;
        this.statsInterval = setInterval(() => void this.pollStats(), 2000);
    }

    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.stats.set(null);
        this.inboundVideoFpsByShareSignal.set({});
        this.prevStatsTs = 0;
    }

    private async pollStats(): Promise<void> {
        if (!this.pc) return;
        const report = await this.pc.getStats();
        const now = Date.now();

        // Independent of the kbps accounting below, which needs two samples to produce a rate -
        // framesPerSecond arrives from the browser pre-computed, so there is no reason to wait for a
        // second poll before showing it.
        this.inboundVideoFpsByShareSignal.set(inboundScreenFpsByShare(report, this.midMap));

        let inAudio = 0, inVideo = 0, outAudio = 0, outVideo = 0, packetsLost = 0;
        report.forEach((stat: RTCStats) => {
            if (stat.type === 'inbound-rtp') {
                const s = stat as RTCInboundRtpStreamStats;
                if (s.kind === 'audio') inAudio += s.bytesReceived ?? 0;
                else inVideo += s.bytesReceived ?? 0;
                packetsLost += s.packetsLost ?? 0;
            } else if (stat.type === 'outbound-rtp') {
                const s = stat as RTCOutboundRtpStreamStats;
                if (s.kind === 'audio') outAudio += s.bytesSent ?? 0;
                else outVideo += s.bytesSent ?? 0;
            }
        });

        if (!this.prevStatsTs) {
            this.prevBytes = {inAudio, inVideo, outAudio, outVideo};
            this.prevStatsTs = now;
            return;
        }

        const dt = (now - this.prevStatsTs) / 1000;
        const kbps = (cur: number, prev: number) =>
            Math.max(0, Math.round(((cur - prev) * 8) / dt / 1000));

        this.stats.set({
            inboundKbps: kbps(inAudio + inVideo, this.prevBytes.inAudio + this.prevBytes.inVideo),
            outboundKbps: kbps(outAudio + outVideo, this.prevBytes.outAudio + this.prevBytes.outVideo),
            inboundAudioKbps: kbps(inAudio, this.prevBytes.inAudio),
            inboundVideoKbps: kbps(inVideo, this.prevBytes.inVideo),
            outboundAudioKbps: kbps(outAudio, this.prevBytes.outAudio),
            outboundVideoKbps: kbps(outVideo, this.prevBytes.outVideo),
            packetsLost,
        });

        this.prevBytes = {inAudio, inVideo, outAudio, outVideo};
        this.prevStatsTs = now;
    }


    // ── Authoritative state reconciliation ────────────────────────────────────

    /**
     * Checks the ring lifecycle and reconciles media against the room snapshot.
     *
     * <p>Two reads, because they answer different questions and only one of them has media in it.
     * `getCall` carries the ring state - was the call completed or rejected, are we still an invited
     * participant - and no media handles at all. `getCallSnapshot` carries who is pullable, on which
     * session, and which screen-share tracks are live. The old code did the whole job from the call
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
        // ownId can be unresolved this early if profileService.ownProfile()
        // hadn't loaded yet when join() computed isLocal (every participant
        // then reads isLocal: false). Treating "no participant matches
        // undefined" as "I was removed" would hang up a call that's actually
        // fine - only act on this check once ownId is actually known.
        if (ownId && !fresh.participants.some(p => p.userId === ownId)) {
            this.callSession.end();
            return;
        }

        await this.refetchSnapshot();
    }

    // ── Recovery ──────────────────────────────────────────────────────────────

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
            console.error('[WebRTC] snapshot refetch failed', err);
        } finally {
            this.refetchInFlight = false;
        }
    }

    /**
     * Take the snapshot and reconcile media against it.
     *
     * <p>This replaces the bespoke caller-side replay the call path grew: the snapshot carries the
     * media handles the old response shape withheld, so one read restores every subscription -
     * including screen shares, which nothing could restore before, because the track name is a UUID
     * chosen by the publisher and appeared in no state a joiner could read.</p>
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
                for (const [name, held] of this.subscribedVideoTracks) {
                    if (held.userId === p.userId) this.subscribedVideoTracks.delete(name);
                }
                void this.dropSource(p.userId);
            }
        }

        for (const p of snapshot.participants) {
            if (p.userId === ownId) continue;
            this.callSession.onParticipantJoined(p.userId);
            // A session id alone is not an invitation to subscribe: `Joined` means a session exists
            // and a microphone track does not, so the pull fails and burns the retry budget.
            if (p.publishState !== 'Publishing' || !p.mediaSessionId || !p.audioTrackName) continue;

            const mediaSessionId = p.mediaSessionId;
            void this.subscribeToTrack(p.userId, mediaSessionId, p.audioTrackName, 'audio');

            for (const share of p.shares) {
                for (const trackName of share.trackNames) {
                    const {kind} = describeTrack(trackName);
                    // Both halves, each on its own path: the video onto this peer connection, the
                    // audio onto the Rust mixer. Sending screen audio down the video branch would
                    // ask the SFU for an audio track on a video transceiver.
                    void this.subscribeToTrack(
                        p.userId, mediaSessionId, trackName,
                        kind === 'screenAudio' ? 'screenAudio' : 'screen',
                        share.shareId);
                }
            }
        }
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
            // The Rust publication, not `this.mediaSessionId`. The webview session is secondary and
            // receive-only; asserting it would hand peers a session with no audio track on it.
            mediaSessionId: this.voiceSession?.mediaSessionId ?? null,
            audioTrackName: this.voiceSession?.trackName ?? null,
        });
    }

    // ── SignalR event listeners ───────────────────────────────────────────────

    private setupWsListeners(): void {
        this.wsSubs = [
            // Someone joined → add to UI and subscribe to their audio track
            this.voiceWs.participantJoinedObservable.subscribe(e => this.gate(e, () => {
                console.log('[WebRTC] ParticipantJoined received in WS listener', e);
                this.callSession.onParticipantJoined(e.userId);
                // Same guard the track-published listener below has carried all along, and for the
                // same reason: since audio moved to its own Rust session this event names the session
                // we publish on, and Cloudflare refuses to let a session pull its own local track.
                // The backfill in syncParticipants already skips ownId; this path did not.
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return;
                void this.subscribeToTrack(e.userId, e.mediaSessionId, e.audioTrackName, 'audio');
            })),

            // New video / screen track published → subscribe to it
            this.voiceWs.trackPublishedObservable.subscribe(e => this.gate(e, () => {
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return; // Skip own tracks
                if (e.kind === 'video') {
                    void this.subscribeToTrack(e.userId, e.mediaSessionId, e.trackName, 'video');
                } else if (e.kind === 'screen') {
                    void this.subscribeToTrack(e.userId, e.mediaSessionId, e.trackName, 'screen', e.shareId);
                } else if (e.kind === 'screenAudio') {
                    void this.subscribeToTrack(e.userId, e.mediaSessionId, e.trackName, 'screenAudio', e.shareId);
                }
            })),

            // Authoritative state, pushed on join, on publish, and whenever the server decides we
            // are out of date. Applied wholesale - it is not a delta.
            this.voiceWs.voiceSnapshotObservable.subscribe(s => this.applySnapshot(s)),
            this.voiceWs.voiceResyncObservable.subscribe(e => {
                if (e.callId === this.callId) this.onResync(e.reason);
            }),

            // A track stopped. Nothing consumed this before, so a republished camera or share was
            // skipped by the dedupe guard below and never came back.
            this.voiceWs.trackClosedObservable.subscribe(e => this.gate(e, () => {
                this.subscribedVideoTracks.delete(e.trackName);
                const {kind, shareId} = describeTrack(e.trackName);
                if (kind === 'video') this.callSession.onCameraChanged(e.userId, false);
                else if (kind === 'screen' && shareId) this.callSession.onScreenShareStopped(shareId);
                else if (kind === 'screenAudio') {
                    // Dropped, or a stopped share keeps its slot in the mixer forever - silent, but
                    // still popped and mixed on every frame.
                    void this.dropSource(e.trackName);
                    this.remoteScreenAudioIds.delete(e.userId);
                }
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
                // Turn-off: update UI immediately (track.onended handles stream cleanup)
                if (!e.isCameraOn) this.callSession.onCameraChanged(e.userId, false);
                // Turn-on: handled by trackPublishedObservable → subscribeToTrack → ontrack → onCameraChanged
            })),

            // Screen share start: surface in UI immediately (stream arrives via ontrack)
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
