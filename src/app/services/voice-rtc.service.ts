import {computed, inject, Injectable, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {firstValueFrom, Subject} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {environment} from '../../environments/environment';
import {ApiConfigService} from "./api-config.service";
import {DeviceIdentityService} from "./device-identity.service";
import {OAuthService} from 'angular-oauth2-oidc';
import {bitrateFor, DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';
import {solveGeometry} from '../models/capture-geometry';
import {publishOptions, useRustPublisher} from './screen-publish';
import {isDeadMediaSession, isStaleSubscription} from '../models/voice-room';
import {VoiceEngineService, VoiceSession} from './voice-engine.service';
import {ScreenPickerChoice} from './screen-picker.service';
import {
    applyScreenEncoding,
    applySimpleBitrate,
    CAMERA_KBPS,
    preferVideoCodecs,
    STREAM_AUDIO_KBPS,
    withStartBitrate,
} from './webrtc-encoding';
import {inboundScreenFpsByUser} from '../shared/call/inbound-fps';

export interface VoiceSpeakingChange {
    userId: string;
    isSpeaking: boolean;
}

/**
 * Backoff between attempts to pull a remote audio track, in milliseconds.
 *
 * Sized against the window this exists to cover. The backend announces a publisher as soon as the
 * SFU accepts their `tracks/new`, which is one SDP answer before they have applied it, finished ICE
 * and DTLS, and sent a packet; until then a pull answers `not_found_track_error`. The backend
 * absorbs about six seconds of that itself, so anything reaching us has already been given a fair
 * chance, and these attempts only need to cover a cold connect on a slow link.
 *
 * Exponential and starting at a second, per the guidance from incident VNT-GE21R3P7: the log there
 * showed the same subscribe reattempted every 5-6 seconds with no backoff at all, which turned one
 * publisher's stale share into a burst of failures. The *stale* case does not retry at all - see
 * `isStaleSubscription` - so what remains here is genuine transport failure, where spacing attempts
 * out costs a little latency in a rare case and removes a stampede in a bad one.
 *
 * Exported so the schedule is asserted rather than described.
 */
export const SUBSCRIBE_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * Emitted when the server says our view of the room is out of date.
 *
 * A subject rather than a direct call into the room service, because the two subscribe paths that
 * can raise it (this one, and the Rust engine's) both live below anything that owns a snapshot.
 */
export interface StaleSubscription {
    /** Whose track we asked for, when it is known. */
    userId?: string;
}

/**
 * A publish that was rebuilt at a new resolution. The share id changed, so viewers have to be told
 * to drop the old track and pick up the new one.
 */
export interface ScreenPublishRestart {
    oldShareId: string;
    /** Null when the rebuild failed: the old share is still gone and must still be announced. */
    newShareId: string | null;
}

@Injectable({providedIn: 'root'})
export class VoiceRTCService {
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);

    private readonly pcState = signal<RTCPeerConnectionState>('new');
    /** True once the Rust engine is capturing and publishing. See {@link rtcState}. */
    private readonly engineUp = signal(false);

    /**
     * What the voice UI shows as the connection state.
     *
     * This peer connection no longer publishes anything, so while you are alone in a channel there
     * is nothing to negotiate and it sits in `'new'` indefinitely - which the status bar reads as
     * "connecting" and would never leave. What the user actually means by "am I connected" is
     * whether their voice is going out, and that is the Rust engine. Once the connection has
     * something to do, its own state takes over again, including its failures.
     */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const pc = this.pcState();
        return pc === 'new' && this.engineUp() ? 'connected' : pc;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    readonly localVideoStream = signal<MediaStream | null>(null);
    readonly localScreenStream = signal<MediaStream | null>(null);

    // ── Signals ────────────────────────────────────────────────────────────────
    readonly localScreenHasAudio = signal<boolean>(false);
    readonly localScreenAudioMuted = signal<boolean>(false);
    readonly screenEnded$ = new Subject<void>();
    private readonly staleSubscriptionSignal = new Subject<StaleSubscription>();
    /** "Your roster is out of date" - the room service refetches the snapshot and reconciles. */
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

    // ── WebRTC internals ───────────────────────────────────────────────────────
    private pc: RTCPeerConnection | null = null;
    private mediaSessionId: string | null = null;
    /**
     * The Rust publication carrying this channel's audio.
     *
     * Held rather than looked up, because the engine now runs several calls at once and every
     * command has to say which one it means. Isle proximity voice holds its own alongside this.
     */
    private voiceSession: VoiceSession | null = null;
    private setupDone = false;

    private localVideoTrack: MediaStreamTrack | null = null;
    private localScreenTrack: MediaStreamTrack | null = null;
    private localScreenAudioTrack: MediaStreamTrack | null = null;
    private screenShareId: string | null = null;

    private cfVideoTrackName: string | null = null;

    // Serialises all SDP offer/answer cycles to prevent races on concurrent track operations.
    private negotiationChain: Promise<void> = Promise.resolve();

    // Maps a remote transceiver MID → { userId, kind }. Video only: audio no longer arrives here.
    private midMeta = new Map<string, { userId: string; kind: 'video' | 'screen' }>();

    /**
     * Remote screen shares' arriving frame rate, by user id - the guild-side twin of
     * `CallWebRtcService.inboundVideoFps`. Polled the same way, off the same `getStats()` mechanism
     * this connection never used to run at all: nothing here read stats before this existed, since
     * nothing downstream needed a number until `CallScreenShare.inboundFps` did.
     */
    private readonly inboundVideoFpsSignal = signal<Record<string, number>>({});
    readonly inboundVideoFps = this.inboundVideoFpsSignal.asReadonly();
    private statsInterval?: ReturnType<typeof setInterval>;

    // Track local senders so bitrate can be changed on the fly
    private readonly localSenders = new Map<string, RTCRtpSender>();

    // Per-user volume, 0-1. The slider position lives here; the gain it produces lives in Rust.
    private readonly userVolumes = new Map<string, number>();

    // userId → the mixer source id of their stream's audio, so the per-stream mute can find it.
    private readonly remoteScreenAudioIds = new Map<string, string>();

    // Mixer source id → the Cloudflare session we are currently pulling it from. Distinguishes a
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

    // Remote video/screen track name → the Cloudflare session it is being pulled from.
    //
    // Video has no equivalent of the audio path's mixer-source identity, so nothing used to stop a
    // second subscribe for the same track: every call added another recvonly transceiver and asked
    // Cloudflare for a track already being pulled. That was harmless while the only route here was
    // the live TrackPublished event, which fires once. It stops being harmless now that the
    // snapshot backfill covers the same tracks - a viewer who is present when a share starts would
    // subscribe twice and leak an m-line per snapshot.
    private readonly subscribedVideoTracks = new Map<string, { mediaSessionId: string; userId: string }>();

    // Subscription key → the publication that was refused as stale, and who it belonged to.
    //
    // `staleSubscription` means that exact track on that exact session has stopped, so the identical
    // request cannot start working: the remedy is to refetch the snapshot and pull whatever replaced
    // it. But the refetch re-announces every track the server still lists, and while the server's
    // record and Cloudflare's disagree that includes the dead one - which we then subscribe to
    // again, are refused again, and refetch again. Nothing sleeps anywhere on that path, so it runs
    // as fast as the network allows: a screenful of `subscribe refused as stale` alternating with
    // 409s, one HTTP request per turn, for as long as the viewer stays in the channel.
    //
    // Recording the refusal is what breaks it. The refetch still happens - it is the only thing that
    // can discover a replacement - but a re-announcement of the same (track, session) pair is now
    // dropped before it reaches the wire. A republish always brings a new session id, so anything
    // genuinely new is unaffected.
    private readonly stalePublications = new Map<string, { mediaSessionId: string; userId: string }>();

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
    /** True while the running share is owned by the Rust publisher rather than this connection. */
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

    constructor() {
        // A share can end without anything in the app asking it to. In a browser that is the
        // *ordinary* way it ends: the publish runs on `getDisplayMedia`, and Chrome's own "Stop
        // sharing" bar tears the track down and tells us afterwards. Nothing else on this side
        // hears it - `localScreenTrack.onended` only covers a share published on this peer
        // connection, and a publisher-owned share has no track here to hang that on. Until this
        // was forwarded, the button stayed lit over a publish that was genuinely gone, and the
        // room was never told the track had stopped.
        //
        // Forwarded into the same subject the desktop `onended` path uses, so the one consumer -
        // `VoiceChannelService`, which calls `toggleScreenShare()` - unwinds it exactly as it would
        // a user-pressed stop: the server is told, and the local state clears.
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
    }

    // ── Connection setup / teardown ────────────────────────────────────────────

    async connect(guildId: string, channelId: string): Promise<boolean> {
        this.setupDone = false;

        // Start the microphone first - if it is unavailable there is no point creating a PC.
        //
        // Capture, processing and publishing all happen in Rust, on its own Cloudflare session.
        // Nothing is added to this peer connection: other clients learn the track from the
        // ParticipantJoined event the backend emits when that session publishes "audio", and it
        // carries the Rust session id.
        //
        // Sending and receiving are independent here - the engine has its own session and its own
        // peer connection - so a slow or wedged engine must not be able to hold up subscriptions on
        // the receive side. It could: the engine start waits on ICE gathering in Rust, and when that
        // stalled, every subscribe queued behind it forever and the only symptom was one-way silence
        // with an empty console.
        try {
            this.voiceSession = await this.voiceEngine.start(
                {kind: 'guild', guildId, channelId},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
                await this.deviceIdentity.deviceId(),
            );
            this.engineUp.set(true);
        } catch (e) {
            console.error('[voice] Rust voice engine failed to start', e);
            this.setupDone = true;
            return false;
        }

        // The receive session is *not* opened here - see ensureReceiveSession. Joining a channel is
        // complete once the engine is publishing and mixing; video is opened by whoever first needs
        // it.
        this.setupDone = true;
        return true;
    }

    /**
     * The peer connection this client receives camera and screen video on, opened on first use.
     *
     * <p>Lazily, and that is the whole point. It used to be opened during {@link connect}, but
     * nothing negotiates it until a camera or a screen share actually appears: audio moved to the
     * Rust engine, so a client that is only listening never sends an offer at all and the connection
     * sits in `'new'` indefinitely. Cloudflare creates the session the moment we ask for one and
     * drops any session whose peer connection never connects - so a session opened at join and first
     * used when somebody starts sharing minutes later was routinely already gone. `tracks/new` then
     * answered 502 `session_error` ("Session appears to be disconnected"), permanently, because
     * nothing rebuilt it: the viewer saw the "sharing" placeholder and never got a picture.</p>
     *
     * <p>Opened where it is first needed, the session is negotiated in the same second it is
     * created, and from then on it is a live connection that stays up on its own.</p>
     */
    private async ensureReceiveSession(guildId: string, channelId: string): Promise<boolean> {
        if (this.pc && this.mediaSessionId) return true;

        const pc = new RTCPeerConnection({iceServers: environment.iceServers, bundlePolicy: 'max-bundle'});
        pc.ontrack = e => this.handleRemoteTrack(e);
        // Guarded on identity: a connection that has been replaced must not keep writing the state
        // its successor is reporting.
        pc.onconnectionstatechange = () => {
            if (this.pc === pc) this.pcState.set(pc.connectionState);
        };

        try {
            // Secondary: the Rust session carries this participant's audio, and only one session per
            // participant may claim that.
            const {mediaSessionId} = await firstValueFrom(
                this.guildVoiceSvc.createSession(guildId, channelId, false));
            this.pc = pc;
            this.mediaSessionId = mediaSessionId;
            this.startStatsPolling();
            return true;
        } catch (e) {
            pc.close();
            console.error('[voice] could not open the receive session', e);
            return false;
        }
    }

    // ── Stats polling ────────────────────────────────────────────────────────

    private startStatsPolling(): void {
        this.stopStatsPolling();
        this.statsInterval = setInterval(() => void this.pollStats(), 2000);
    }

    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.inboundVideoFpsSignal.set({});
    }

    private async pollStats(): Promise<void> {
        if (!this.pc) return;
        const report = await this.pc.getStats();
        this.inboundVideoFpsSignal.set(inboundScreenFpsByUser(report, this.midMeta));
    }

    /**
     * Throw away a receive session the server has declared gone, so the next subscribe opens a
     * fresh one.
     *
     * <p>Unconditional, including when a camera or screen share is publishing on it. That is not a
     * choice this makes lightly: the session is <em>already</em> spent, so those tracks are dead at
     * the SFU whatever the local UI says, and every call on that id fails identically from now on.
     * Keeping the connection to preserve them would preserve nothing but the appearance of them, and
     * cost the subscription that could have been recovered.</p>
     *
     * <p>So the local capture is stopped and its state cleared, which makes the UI say what is
     * actually true - the camera is off - instead of showing it live to a room that cannot see it.
     * Turning it back on republishes onto the new session. Doing that automatically would be
     * friendlier and is worth doing; it is a larger change than this recovery path.</p>
     */
    private dropReceiveSession(): boolean {
        this.localVideoTrack?.stop();
        this.localVideoTrack = null;
        this.localVideoStream.set(null);
        this.cfVideoTrackName = null;
        // The Rust publisher owns its own session and is untouched by this; only a share published
        // on *this* connection dies with it.
        if (!this.rustPublishing) {
            this.localScreenTrack?.stop();
            this.localScreenAudioTrack?.stop();
            this.localScreenTrack = null;
            this.localScreenAudioTrack = null;
            this.localScreenStream.set(null);
            this.localScreenHasAudio.set(false);
            this.screenShareId = null;
            this.screenPreset.set(null);
        }
        this.localSenders.clear();
        this.stopStatsPolling();
        this.pc?.close();
        this.pc = null;
        this.mediaSessionId = null;
        this.pcState.set('new');
        this.midMeta.clear();
        // Cleared with the session that held them: a claim recorded against a connection that no
        // longer exists would make every resubscribe look like a duplicate and skip it.
        this.subscribedVideoTracks.clear();
        this.videoStreamsSignal.set(new Map());
        this.screenStreamsSignal.set(new Map());
        return true;
    }

    /**
     * What this client is actually publishing, for the heartbeat's state assertion.
     *
     * <p>Deliberately the *Rust* session and not `this.mediaSessionId`. The webview's session is
     * secondary and receive-only; the microphone lives on the Rust publication, and that is the
     * session peers are told to pull from. Asserting the webview's would have the server hand peers
     * a session with no audio track on it.</p>
     *
     * <p>Null while not publishing, which is the honest thing to send - the server corrects its
     * record from it and tells peers to drop us.</p>
     */
    get publishedMedia(): { mediaSessionId: string; audioTrackName: string } | null {
        if (!this.voiceSession) return null;
        return {
            mediaSessionId: this.voiceSession.mediaSessionId,
            audioTrackName: this.voiceSession.trackName,
        };
    }

    /**
     * Names of all local tracks published on *this* connection's session, for the close-tracks call.
     *
     * The microphone is not among them: it lives on the Rust session, which closes its own track,
     * exactly as the screen publisher does.
     */
    getActiveTrackNames(): string[] {
        const names: string[] = [];
        if (this.cfVideoTrackName) names.push(this.cfVideoTrackName);
        if (this.localScreenTrack && this.screenShareId) {
            names.push(`screen-${this.screenShareId}`);
            if (this.localScreenAudioTrack) names.push(`screen-audio-${this.screenShareId}`);
        }
        return names;
    }

    teardown(): void {
        this.localSenders.clear();
        this.subscribedAudioSessions.clear();
        this.subscribedVideoTracks.clear();
        this.stalePublications.clear();
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
        this.engineUp.set(false);
        this.localVideoTrack?.stop();
        this.localScreenTrack?.stop();
        void this.rustMedia.stopScreenCapture();
        this.localScreenAudioTrack?.stop();

        this.localVideoTrack = null;
        this.localScreenTrack = null;
        this.localScreenAudioTrack = null;
        this.screenShareId = null;
        this.screenSourceSize = null;
        this.screenPreset.set(null);

        this.stopStatsPolling();
        this.pc?.close();
        this.pcState.set('new');
        this.participantsWithAudio.set(new Set());
        this.pc = null;
        this.mediaSessionId = null;
        this.cfVideoTrackName = null;
        this.setupDone = false;
        this.midMeta.clear();
        this.negotiationChain = Promise.resolve();

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

    /** Cleans up all per-participant resources when a remote user leaves. */
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
        for (const [, held] of this.subscribedVideoTracks) ids.add(held.userId);
        return [...ids];
    }

    cleanupParticipant(userId: string): void {
        // Drops their source from the mixer, their entry from the mid map, and their volume.
        //
        // Queued behind any subscribe still running for them, or the drop lands first and the
        // subscribe it was meant to undo finishes afterwards - putting a participant who has left
        // back in the mix. The token bumped below is what stops that subscribe recording itself.
        void this.queueAudioOp(userId, () => this.dropSource(userId));
        // Forget the session they were on, so rejoining resubscribes rather than being skipped as
        // a duplicate - a leave/rejoin almost always comes back on a new Cloudflare session.
        this.subscribedAudioSessions.delete(userId);
        // Invalidate any retry still sleeping for them. Without this, someone who leaves during
        // the backoff is resubscribed seconds later and stays in the mix until the next teardown.
        this.subscribeTokens.set(userId, (this.subscribeTokens.get(userId) ?? 0) + 1);
        // Same reasoning for their video: a rejoin comes back on a new session, and a stale claim
        // here would make the resubscribe look like a duplicate and skip it.
        for (const [name, held] of this.subscribedVideoTracks) {
            if (held.userId === userId) this.subscribedVideoTracks.delete(name);
        }
        // And the record of what of theirs was refused. Keyed by session id, so it would not block
        // a rejoin on its own - but it would otherwise sit in the map for the rest of the call.
        for (const [key, held] of this.stalePublications) {
            if (held.userId === userId) this.stalePublications.delete(key);
        }

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
     * Nothing is added to this peer connection any more: audio arrives on the Rust session, is
     * decoded, jitter-buffered and mixed there, and leaves through the output device Rust opened.
     * This connection now carries video and screen video only.
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
        // The two do not always agree - the live announcement carries the session id that was
        // just passed in, the backfill reads whatever is on the participant row, which is stale
        // if they rejoined. Acting on that difference is the only recovery path there is.
        const previous = this.subscribedAudioSessions.get(id);
        if (previous === target.mediaSessionId) return;
        // Already refused as stale. The refetch that followed has re-announced it unchanged, so
        // asking again would only earn the same 409 and another refetch.
        if (this.stalePublications.get(id)?.mediaSessionId === target.mediaSessionId) return;
        if (previous !== undefined) {
            // The old subscription points at a session that is no longer publishing. Drop it,
            // or the mixer keeps a dead source and Rust keeps a recvonly transceiver per
            // announcement - one leaked m-line every time somebody rejoins.
            console.warn('[voice] session id changed, resubscribing', {
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
                // skip the very announcement that could have carried a working session id.
                this.subscribedAudioSessions.set(id, target.mediaSessionId);
                this.stalePublications.delete(id);
                if (target.kind === 'screenAudio') {
                    this.remoteScreenAudioIds.set(target.userId, id);
                    // A stream that starts while its author is already muted must stay muted.
                    if (this.screenAudioMutedSignal().has(target.userId)) {
                        void this.voiceEngine.setUserVolume(id, 0);
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
                if (isStaleSubscription(e)) {
                    // Not late - gone. The identical body fails again for as long as we keep
                    // trying, which is the loop behind VNT-GE21R3P7. Nothing is recorded as
                    // subscribed above, so the refetch below is free to try again properly - and
                    // the pair is recorded as dead so that a refetch which re-announces it
                    // unchanged stops here instead of coming straight back round.
                    console.warn('[voice] subscribe refused as stale, refetching', {id});
                    this.stalePublications.set(id, {
                        mediaSessionId: target.mediaSessionId,
                        userId: target.userId,
                    });
                    this.staleSubscriptionSignal.next({userId: target.userId});
                    return;
                }
                if (attempt < SUBSCRIBE_RETRY_DELAYS_MS.length) {
                    // Expected, not exceptional. The backend announces a publisher the moment
                    // Cloudflare accepts their tracks/new, which is one SDP answer *before* they
                    // have finished ICE and DTLS and sent a packet - so an early subscribe gets
                    // not_found_track_error for a track that is about to exist. The backend absorbs
                    // 1.5s of that; a cold handshake on a slow link outlasts it.
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
     * Pull a remote camera or screen track onto this connection.
     *
     * <p>Idempotent per (track name, publishing session): calling it again for a track already
     * being pulled from the same session returns without touching the peer connection, so the live
     * announcement and the snapshot backfill can both cover a track without subscribing twice. A
     * *different* session id for the same name means the publisher restarted and is a real
     * resubscribe.</p>
     */
    subscribeVideo(
        guildId: string,
        channelId: string,
        userId: string,
        mediaSessionId: string,
        trackName: string,
        kind: 'video' | 'screen',
    ): Promise<void> {
        if (this.subscribedVideoTracks.get(trackName)?.mediaSessionId === mediaSessionId) return Promise.resolve();
        if (this.stalePublications.get(trackName)?.mediaSessionId === mediaSessionId) return Promise.resolve();

        return this.enqueueNegotiation(async () => {
            // Inside the queue, so the session is opened once however many tracks are announced at
            // the same moment - a snapshot backfill covering a share announces two.
            if (!await this.ensureReceiveSession(guildId, channelId)) return;
            if (!this.pc || !this.mediaSessionId) return;
            // Re-checked inside the queue: two callers can pass the guard above before either has
            // run, and the queue is what serialises them.
            if (this.subscribedVideoTracks.get(trackName)?.mediaSessionId === mediaSessionId) return;
            if (this.stalePublications.get(trackName)?.mediaSessionId === mediaSessionId) return;

            const transceiver = this.pc.addTransceiver('video', {direction: 'recvonly'});
            preferVideoCodecs(transceiver, 'receiver');

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            try {
                const resp = await firstValueFrom(this.guildVoiceSvc.negotiateTracks(guildId, channelId, {
                    mediaSessionId: this.mediaSessionId,
                    sessionDescription: this.pc.localDescription!,
                    tracks: [{direction: 'subscribe', trackName, mediaSessionId}],
                }));

                if (resp.tracks[0]?.mid) {
                    this.midMeta.set(resp.tracks[0].mid, {userId, kind});
                }

                await this.pc.setRemoteDescription(resp.sessionDescription);
                // Recorded only once it worked. Claiming the track before the round trip would make
                // every later attempt - the next snapshot, a republish - skip the one thing that
                // could have recovered it, which is how a transient 502 becomes a permanently black
                // tile.
                this.subscribedVideoTracks.set(trackName, {mediaSessionId, userId});
                this.stalePublications.delete(trackName);
                if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
            } catch (e) {
                if (isStaleSubscription(e)) {
                    // The share stopped between the announcement and this request. Nothing is
                    // recorded in subscribedVideoTracks - that happens only on success - so the
                    // reconcile that follows the refetch can subscribe cleanly if it comes back.
                    // The dead pair is recorded so the refetch cannot hand the same one back.
                    console.warn('[voice] video subscribe refused as stale, refetching', {trackName});
                    this.stalePublications.set(trackName, {mediaSessionId, userId});
                    this.staleSubscriptionSignal.next({userId});
                    return;
                }
                if (isDeadMediaSession(e) && this.dropReceiveSession()) {
                    // Our own receive session, not the track. Rebuilding it is the only thing that
                    // can help, and the refetch that follows re-announces every track worth pulling
                    // - which opens a fresh session on the way through.
                    console.warn('[voice] receive session is dead, rebuilding', {trackName});
                    this.staleSubscriptionSignal.next({userId});
                    return;
                }
                console.error('[voice] video subscribe failed', {userId, trackName, kind}, e);
                throw e;
            }
        });
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

    async publishCamera(guildId: string, channelId: string): Promise<string | null> {
        if (!await this.ensureReceiveSession(guildId, channelId)) return null;

        try {
            // Honour the camera picked in settings; this used to hardcode `video: true` and always
            // open the system default.
            const stream = await navigator.mediaDevices.getUserMedia({
                video: await this.audioSettings.buildVideoConstraint(),
                audio: false,
            });
            this.localVideoTrack = stream.getVideoTracks()[0];
            this.localVideoStream.set(new MediaStream([this.localVideoTrack]));

            let cfTrackName: string | null = null;
            await this.enqueueNegotiation(async () => {
                if (!this.pc || !this.mediaSessionId) return;
                const sender = this.pc.addTrack(this.localVideoTrack!, stream);
                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);
                const mid = this.pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';
                const resp = await firstValueFrom(this.guildVoiceSvc.negotiateTracks(guildId, channelId, {
                    mediaSessionId: this.mediaSessionId!,
                    sessionDescription: this.pc.localDescription!,
                    tracks: [{direction: 'publish', mid, trackName: 'video'}],
                }));
                cfTrackName = this.cfVideoTrackName = resp.tracks[0]?.trackName ?? 'video';
                await this.pc.setRemoteDescription(resp.sessionDescription);
                if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
                await applySimpleBitrate(sender, CAMERA_KBPS);
                this.localSenders.set('video', sender);
            });
            return cfTrackName;
        } catch {
            return null;
        }
    }

    async closeCamera(guildId: string, channelId: string): Promise<void> {
        if (!this.pc || !this.mediaSessionId || !this.localVideoTrack) return;
        this.localVideoTrack.stop();
        const sender = this.pc.getSenders().find(s => s.track === this.localVideoTrack);
        if (sender) this.pc.removeTrack(sender);
        await firstValueFrom(
            this.guildVoiceSvc.closeTracks(guildId, channelId, this.mediaSessionId, [this.cfVideoTrackName ?? 'video'])
        ).catch(() => {
        });
        this.localVideoTrack = null;
        this.localVideoStream.set(null);
        this.localSenders.delete('video');
        this.cfVideoTrackName = null;
    }

    async publishScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
        try {
            const choice = await this.screenPicker.show();
            if (!choice) return null;

            const {sourceId, preset, shareAudio, sourceWidth, sourceHeight} = choice;
            this.screenPreset.set(preset);
            this.screenSourceSize = {width: sourceWidth, height: sourceHeight};

            // Checked after the Rust branch, not before it. The Rust publisher owns its own session
            // and needs nothing from this connection, so requiring one here would have made screen
            // sharing depend on a receive session that may not exist yet.
            if (useRustPublisher()) {
                return await this.publishScreenFromRust(guildId, channelId, choice);
            }
            if (!await this.ensureReceiveSession(guildId, channelId)) return null;

            // Solved once, before capture starts, and held for the session.
            const geometry = solveGeometry(sourceWidth, sourceHeight, preset.resolution);
            const videoTrack = await this.rustMedia.startScreenCapture(sourceId, geometry, preset.framerate);
            this.localScreenTrack = videoTrack;
            this.localScreenStream.set(new MediaStream([videoTrack]));

            let audioTrack: MediaStreamTrack | null = null;
            if (shareAudio) {
                try {
                    audioTrack = await this.rustMedia.startLoopbackCapture();
                } catch {
                    console.warn('[ScreenShare] Loopback audio unavailable');
                }
            }
            this.localScreenAudioTrack = audioTrack;
            this.localScreenHasAudio.set(audioTrack !== null);
            this.localScreenAudioMuted.set(false);

            const stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
            const shareId = crypto.randomUUID();
            this.screenShareId = shareId;

            this.localScreenTrack.onended = () => this.screenEnded$.next();

            await this.enqueueNegotiation(async () => {
                if (!this.pc || !this.mediaSessionId) return;

                const videoSender = this.pc.addTrack(this.localScreenTrack!, stream);
                const audioSender = this.localScreenAudioTrack
                    ? this.pc.addTrack(this.localScreenAudioTrack, stream)
                    : null;

                // VP9 for screen sharing: better quality-per-bit at the same bitrate vs VP8.
                const videoTransceiver = this.pc.getTransceivers().find(t => t.sender === videoSender);
                if (videoTransceiver) preferVideoCodecs(videoTransceiver, 'sender');

                const offer = await this.pc.createOffer();
                // Open near the target rate instead of letting congestion control ramp from
                // ~300 kbps over the first half-minute.
                await this.pc.setLocalDescription({
                    type: offer.type,
                    sdp: withStartBitrate(offer.sdp ?? '', bitrateFor(preset)),
                });

                const videoMid = this.pc.getTransceivers().find(t => t.sender === videoSender)?.mid ?? '0';
                const tracks: { direction: 'publish'; mid: string; trackName: string }[] = [
                    {direction: 'publish', mid: videoMid, trackName: `screen-${shareId}`},
                ];
                if (audioSender) {
                    const audioMid = this.pc.getTransceivers().find(t => t.sender === audioSender)?.mid ?? '1';
                    tracks.push({direction: 'publish', mid: audioMid, trackName: `screen-audio-${shareId}`});
                }

                const resp = await firstValueFrom(this.guildVoiceSvc.negotiateTracks(guildId, channelId, {
                    mediaSessionId: this.mediaSessionId!,
                    sessionDescription: this.pc.localDescription!,
                    tracks,
                }));
                await this.pc.setRemoteDescription(resp.sessionDescription);
                if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
                await applyScreenEncoding(videoSender, preset);
                this.localSenders.set('screenVideo', videoSender);
                if (audioSender) {
                    await applySimpleBitrate(audioSender, STREAM_AUDIO_KBPS);
                    this.localSenders.set('screenAudio', audioSender);
                }
            });

            return {shareId};
        } catch {
            return null;
        }
    }

    async closeScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
        if (this.rustPublishing) {
            // The publisher owns its own session and closes its own tracks; nothing on this peer
            // connection needs unwinding.
            const shareId = this.screenShareId ?? 'share';
            await this.rustMedia.stopScreenPublish();
            this.rustPublishing = false;
            this.rustChoice = null;
            this.rustAudioTrackName = null;
            this.localScreenHasAudio.set(false);
            this.localScreenAudioMuted.set(false);
            this.screenShareId = null;
            this.screenSourceSize = null;
            this.screenPreset.set(null);
            return {shareId};
        }
        if (!this.pc || !this.mediaSessionId || !this.localScreenTrack) return null;

        const shareId = this.screenShareId ?? 'share';
        const trackNames = [`screen-${shareId}`];
        if (this.localScreenAudioTrack) trackNames.push(`screen-audio-${shareId}`);

        this.localScreenTrack.stop();
        void this.rustMedia.stopScreenCapture();
        void this.rustMedia.stopLoopbackCapture();

        const videoSender = this.pc.getSenders().find(s => s.track === this.localScreenTrack);
        if (videoSender) this.pc.removeTrack(videoSender);

        if (this.localScreenAudioTrack) {
            this.localScreenAudioTrack.stop();
            const audioSender = this.pc.getSenders().find(s => s.track === this.localScreenAudioTrack);
            if (audioSender) this.pc.removeTrack(audioSender);
            this.localScreenAudioTrack = null;
        }

        await firstValueFrom(
            this.guildVoiceSvc.closeTracks(guildId, channelId, this.mediaSessionId, trackNames)
        ).catch(() => {
        });

        this.localScreenTrack = null;
        this.screenShareId = null;
        this.screenSourceSize = null;
        this.screenPreset.set(null);
        this.localSenders.delete('screenVideo');
        this.localSenders.delete('screenAudio');
        this.localScreenStream.set(null);
        this.localScreenHasAudio.set(false);
        this.localScreenAudioMuted.set(false);

        return {shareId};
    }

    /**
     * Publish the screen entirely from Rust, on its own Cloudflare session.
     *
     * Nothing is added to this peer connection: the track lives on the publisher's session, and
     * subscribers reach it through the TrackPublished event, which carries that session id. The
     * local tile has no stream to show, so it falls back to its placeholder.
     */
    private async publishScreenFromRust(
        guildId: string,
        channelId: string,
        choice: ScreenPickerChoice,
    ): Promise<{ shareId: string } | null> {
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
                ),
            );
            console.log(`[voice] Rust publisher live on ${published.encoder}`, published);
            this.screenShareId = shareId;
            this.rustPublishing = true;
            this.rustChoice = choice;
            // What Rust actually published, not what was asked for: the loopback device can be
            // unavailable, and the share is then video-only. Driving the UI from `choice.shareAudio`
            // would show a speaker icon on a share that carries no sound.
            this.rustAudioTrackName = published.audioTrackName;
            this.localScreenHasAudio.set(published.audioTrackName !== null);
            this.localScreenAudioMuted.set(false);
            return {shareId};
        } catch (e) {
            console.error('[voice] Rust publish failed', e);
            this.screenPreset.set(null);
            this.screenSourceSize = null;
            return null;
        }
    }

    /**
     * Change stream quality mid-share, the way Discord's stream-settings cog does.
     *
     * A framerate change is free - the Rust capture loop reads it each frame. A resolution change
     * costs one renegotiation and keyframe, which is acceptable because the user asked for it.
     */
    async setScreenPreset(
        preset: StreamPreset,
        guildId?: string,
        channelId?: string,
    ): Promise<ScreenPublishRestart | null> {
        const previous = this.screenPreset() ?? DEFAULT_STREAM_PRESET;
        this.screenPreset.set(preset);

        if (this.rustPublishing) {
            // Framerate is live - the capture loop re-reads it every frame.
            if (preset.framerate !== previous.framerate) {
                await this.rustMedia.setPublishFps(preset.framerate);
            }
            // Resolution and bitrate are baked into the encoder at construction, so changing them
            // means a new encoder, a new session and therefore a new share id. The caller has to
            // announce the swap; it cannot be done silently.
            if (preset.resolution !== previous.resolution && guildId && channelId && this.rustChoice) {
                return await this.restartRustPublish(guildId, channelId, preset);
            }
            return null;
        }

        if (!this.localScreenTrack) return null;

        if (preset.framerate !== previous.framerate) {
            await this.rustMedia.setCaptureFps(preset.framerate);
        }
        if (preset.resolution !== previous.resolution && this.screenSourceSize) {
            const {width, height} = this.screenSourceSize;
            await this.rustMedia.setCaptureGeometry(solveGeometry(width, height, preset.resolution));
        }
        const sender = this.localSenders.get('screenVideo');
        if (sender) await applyScreenEncoding(sender, preset);
        return null;
    }

    /**
     * Rebuild the publish at a new resolution.
     *
     * The encoder is fixed to one geometry, so this tears the publish down and starts a fresh one.
     * That yields a new Cloudflare session and a new share id, which the caller must announce so
     * viewers drop the old track and subscribe to the new one.
     */
    private async restartRustPublish(
        guildId: string,
        channelId: string,
        preset: StreamPreset,
    ): Promise<ScreenPublishRestart | null> {
        const choice = this.rustChoice;
        const oldShareId = this.screenShareId;
        if (!choice || !oldShareId) return null;

        await this.rustMedia.stopScreenPublish();
        this.rustPublishing = false;

        const started = await this.publishScreenFromRust(guildId, channelId, {...choice, preset});
        // Reported either way. The old publish is gone the moment the line above returns, so the
        // room has to be told even when nothing replaced it - and a rebuild is exactly when that
        // fails, because the encoder is being constructed at a resolution it may refuse. Returning
        // null here used to swallow the stop entirely, leaving the share on the server's roster
        // with no session behind it: every viewer then pulled a track the SFU no longer had.
        if (!started) {
            this.screenShareId = null;
            return {oldShareId, newShareId: null};
        }
        return {oldShareId, newShareId: started.shareId};
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
        if (shareId) void this.voiceEngine.setUserVolume(shareId, willMute ? 0 : 1);
        this.screenAudioMutedSignal.update(s => {
            const n = new Set(s);
            willMute ? n.add(userId) : n.delete(userId);
            return n;
        });
    }

    toggleLocalScreenAudio(): void {
        const muted = !this.localScreenAudioMuted();

        if (this.rustPublishing) {
            // Nothing to disable on this side - the track lives in Rust. Without this branch the
            // control was dead for every Rust-published share: the button moved, the signal moved,
            // and the audio kept going out.
            if (!this.rustAudioTrackName) return;
            void this.rustMedia.setScreenAudioMuted(muted);
            this.localScreenAudioMuted.set(muted);
            return;
        }

        if (!this.localScreenAudioTrack) return;
        this.localScreenAudioTrack.enabled = !muted;
        this.localScreenAudioMuted.set(muted);
    }

    getVideoStream(userId: string): MediaStream | null {
        return this.videoStreamsSignal().get(userId) ?? null;
    }

    getScreenStream(userId: string): MediaStream | null {
        return this.screenStreamsSignal().get(userId) ?? null;
    }

    /** Closes all currently published local tracks via the Cloudflare Calls API. */
    async closeAllTracks(guildId: string, channelId: string): Promise<void> {
        if (!this.mediaSessionId) return;
        const trackNames = this.getActiveTrackNames();
        if (trackNames.length > 0) {
            await firstValueFrom(
                this.guildVoiceSvc.closeTracks(guildId, channelId, this.mediaSessionId, trackNames)
            ).catch(() => {
            });
        }
    }

    /** Updates stream/audio state when a remote participant's track is closed by the server. */
    handleRemoteTrackClosed(trackName: string, userId: string): void {
        // Released here so a republish of the same name resubscribes instead of being skipped.
        this.subscribedVideoTracks.delete(trackName);
        if (trackName === 'video') {
            this.videoStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        } else if (trackName.startsWith('screen-audio-')) {
            // Drop the source, or a stopped stream keeps its slot in the mixer forever - silent,
            // but still popped and mixed on every frame.
            void this.dropSource(trackName);
            this.remoteScreenAudioIds.delete(userId);
        } else if (trackName.startsWith('screen-')) {
            this.screenStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private handleRemoteTrack(event: RTCTrackEvent): void {
        const mid = event.transceiver.mid;
        if (!mid) return;
        const meta = this.midMeta.get(mid);
        if (!meta) return;

        const stream = event.streams[0] ?? new MediaStream([event.track]);

        // No audio branch: audio never reaches this connection now. It is pulled, decoded and mixed
        // on the Rust session and played through the output device Rust owns.
        if (meta.kind === 'video') {
            this.videoStreamsSignal.update(m => {
                const n = new Map(m);
                n.set(meta.userId, stream);
                return n;
            });
        } else {
            this.screenStreamsSignal.update(m => {
                const n = new Map(m);
                n.set(meta.userId, stream);
                return n;
            });
        }
    }

    private enqueueNegotiation(fn: () => Promise<void>): Promise<void> {
        const next = this.negotiationChain.catch(() => {
        }).then(fn);
        this.negotiationChain = next.catch(() => {
        });
        return next;
    }

    private async renegotiate(guildId: string, channelId: string): Promise<void> {
        if (!this.pc || !this.mediaSessionId) return;
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        const resp = await firstValueFrom(this.guildVoiceSvc.renegotiate(guildId, channelId, this.mediaSessionId, offer));
        await this.pc.setRemoteDescription(resp.sessionDescription);
    }

}
