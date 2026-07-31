import {computed, inject, Injectable, signal} from '@angular/core';
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
import {VoiceEngineService} from './voice-engine.service';
import {ScreenPickerChoice} from './screen-picker.service';
import {
    applyScreenEncoding,
    applySimpleBitrate,
    CAMERA_KBPS,
    preferVideoCodecs,
    STREAM_AUDIO_KBPS,
    withStartBitrate,
} from './webrtc-encoding';

export interface VoiceSpeakingChange {
    userId: string;
    isSpeaking: boolean;
}

/**
 * Backoff between attempts to pull a remote audio track, in milliseconds.
 *
 * Sized against the window this exists to cover. The backend announces a publisher as soon as
 * Cloudflare accepts their `tracks/new`, which is one SDP answer before they have applied it,
 * finished ICE and DTLS, and sent a packet; until then Cloudflare answers a pull with
 * `not_found_track_error`. The backend already absorbs 1.5s of that, so the first retry is short -
 * a healthy handshake is done well inside it - and the rest stretch out to cover a cold connect on
 * a slow link without retrying into a failure that is never going to clear.
 *
 * Exported so the schedule is asserted rather than described.
 */
export const SUBSCRIBE_RETRY_DELAYS_MS = [500, 1500, 3000] as const;

/**
 * A publish that was rebuilt at a new resolution. The share id changed, so viewers have to be told
 * to drop the old track and pick up the new one.
 */
export interface ScreenPublishRestart {
    oldShareId: string;
    newShareId: string;
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
    private cfSessionId: string | null = null;
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
    private readonly oauth = inject(OAuthService);

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
        // Deliberately *outside* the negotiation queue block below. Sending and receiving are
        // independent here - the engine has its own session and its own peer connection - so a slow
        // or wedged engine must not be able to hold up subscriptions on this one. It could: the
        // engine start waits on ICE gathering in Rust, and when that stalled, every subscribe
        // queued behind it forever and the only symptom was one-way silence with an empty console.
        try {
            await this.voiceEngine.start(
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

        // Block the negotiation queue until the session exists, so that GuildParticipantJoined WS
        // events don't try to subscribe before there is a session to subscribe on.
        let releaseQueue!: () => void;
        this.negotiationChain = new Promise<void>(resolve => {
            releaseQueue = resolve;
        });

        try {
            this.pc = new RTCPeerConnection({iceServers: environment.iceServers, bundlePolicy: 'max-bundle'});
            this.pc.ontrack = e => this.handleRemoteTrack(e);
            this.pc.onconnectionstatechange = () => {
                if (this.pc) this.pcState.set(this.pc.connectionState);
            };

            // Secondary: the Rust session opened above is the one carrying this participant's audio,
            // and only one session per participant may claim that.
            const {cfSessionId} = await firstValueFrom(
                this.guildVoiceSvc.createSession(guildId, channelId, false));
            this.cfSessionId = cfSessionId;

            // No offer/answer here. There is no local track to publish, and an offer carrying only
            // unused recvonly m-lines asks Cloudflare to answer a subscription that was never
            // requested. The first negotiation is now whatever the first subscribeAudio issues, and
            // its m-lines match the tracks it asks for one-to-one.
            this.setupDone = true;
            return true;

        } catch (e) {
            console.log(e)
            throw e
        } finally {
            releaseQueue();
        }
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
        // Bumped, not cleared: a cleared map reads as token 0 to a retry that is still sleeping,
        // which is the value it would match if it was the first attempt for that source.
        this.subscribeTokens.forEach((token, id) => this.subscribeTokens.set(id, token + 1));

        // Stops capture, playout and every subscription in one call - the Rust session owns all of
        // them, so there is nothing per-participant left to unwind here.
        void this.voiceEngine.stop();
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

        this.pc?.close();
        this.pcState.set('new');
        this.participantsWithAudio.set(new Set());
        this.pc = null;
        this.cfSessionId = null;
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

    /** Cleans up all per-participant resources when a remote user leaves. */
    cleanupParticipant(userId: string): void {
        // Drops their source from the mixer, their entry from the mid map, and their volume.
        void this.voiceEngine.unsubscribe(userId);
        // Forget the session they were on, so rejoining resubscribes rather than being skipped as
        // a duplicate - a leave/rejoin almost always comes back on a new Cloudflare session.
        this.subscribedAudioSessions.delete(userId);
        // Invalidate any retry still sleeping for them. Without this, someone who leaves during
        // the backoff is resubscribed seconds later and stays in the mix until the next teardown.
        this.subscribeTokens.set(userId, (this.subscribeTokens.get(userId) ?? 0) + 1);

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
        targets: { userId: string; cfSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' }[],
    ): Promise<void> {
        // Concurrently, because a subscribe now retries for several seconds before giving up.
        // Sequentially, one participant losing the publish race would hold up everyone announced
        // alongside them - which is exactly what happens when we join a busy channel and the
        // backfill announces the whole room at once.
        await Promise.all(targets.map(target => this.subscribeOne(target)));
    }

    private async subscribeOne(
        target: { userId: string; cfSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' },
    ): Promise<void> {
        // Voice keys on the user; a stream's audio keys on its track name, so muting a stream
        // does not mute the voice of whoever is streaming.
        const id = target.kind === 'screenAudio' ? target.trackName : target.userId;

        // A participant is announced twice: once live when they publish, and once more out of
        // the stored record when *we* join and the backend backfills everyone already present.
        // The two do not always agree - the live announcement carries the session id that was
        // just passed in, the backfill reads whatever is on the participant row, which is stale
        // if they rejoined. Acting on that difference is the only recovery path there is.
        const previous = this.subscribedAudioSessions.get(id);
        if (previous === target.cfSessionId) return;
        if (previous !== undefined) {
            // The old subscription points at a session that is no longer publishing. Drop it,
            // or the mixer keeps a dead source and Rust keeps a recvonly transceiver per
            // announcement - one leaked m-line every time somebody rejoins.
            console.warn('[voice] session id changed, resubscribing', {
                id, from: previous, to: target.cfSessionId,
            });
            await this.voiceEngine.unsubscribe(id);
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
                await this.voiceEngine.subscribe(id, target.cfSessionId, target.trackName);
                if (this.subscribeTokens.get(id) !== token) {
                    // Superseded while the call was in flight. Drop what we just took, or it
                    // outlives the participant it belongs to.
                    await this.voiceEngine.unsubscribe(id);
                    return;
                }
                // Only after it succeeds. Recording a failed subscribe would make the retry above
                // skip the very announcement that could have carried a working session id.
                this.subscribedAudioSessions.set(id, target.cfSessionId);
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

    subscribeVideo(
        guildId: string,
        channelId: string,
        userId: string,
        cfSessionId: string,
        trackName: string,
        kind: 'video' | 'screen',
    ): Promise<void> {
        return this.enqueueNegotiation(async () => {
            if (!this.pc || !this.cfSessionId) return;

            const transceiver = this.pc.addTransceiver('video', {direction: 'recvonly'});
            preferVideoCodecs(transceiver, 'receiver');

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
                cfSessionId: this.cfSessionId,
                sessionDescription: this.pc.localDescription!,
                tracks: [{location: 'remote', trackName, sessionId: cfSessionId}],
            }));

            if (resp.tracks[0]?.mid) {
                this.midMeta.set(resp.tracks[0].mid, {userId, kind});
            }

            await this.pc.setRemoteDescription(resp.sessionDescription);
            if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
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
        if (!this.pc || !this.cfSessionId) return null;

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
                if (!this.pc || !this.cfSessionId) return;
                const sender = this.pc.addTrack(this.localVideoTrack!, stream);
                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);
                const mid = this.pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';
                const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
                    cfSessionId: this.cfSessionId!,
                    sessionDescription: this.pc.localDescription!,
                    tracks: [{location: 'local', mid, trackName: 'video'}],
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
        if (!this.pc || !this.cfSessionId || !this.localVideoTrack) return;
        this.localVideoTrack.stop();
        const sender = this.pc.getSenders().find(s => s.track === this.localVideoTrack);
        if (sender) this.pc.removeTrack(sender);
        await firstValueFrom(
            this.guildVoiceSvc.closeTracks(guildId, channelId, this.cfSessionId, [this.cfVideoTrackName ?? 'video'])
        ).catch(() => {
        });
        this.localVideoTrack = null;
        this.localVideoStream.set(null);
        this.localSenders.delete('video');
        this.cfVideoTrackName = null;
    }

    async publishScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
        if (!this.pc || !this.cfSessionId) return null;

        try {
            const choice = await this.screenPicker.show();
            if (!choice) return null;

            const {sourceId, preset, shareAudio, sourceWidth, sourceHeight} = choice;
            this.screenPreset.set(preset);
            this.screenSourceSize = {width: sourceWidth, height: sourceHeight};

            if (useRustPublisher()) {
                return await this.publishScreenFromRust(guildId, channelId, choice);
            }

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
                if (!this.pc || !this.cfSessionId) return;

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
                const tracks: { location: 'local'; mid: string; trackName: string }[] = [
                    {location: 'local', mid: videoMid, trackName: `screen-${shareId}`},
                ];
                if (audioSender) {
                    const audioMid = this.pc.getTransceivers().find(t => t.sender === audioSender)?.mid ?? '1';
                    tracks.push({location: 'local', mid: audioMid, trackName: `screen-audio-${shareId}`});
                }

                const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
                    cfSessionId: this.cfSessionId!,
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
            this.screenShareId = null;
            this.screenSourceSize = null;
            this.screenPreset.set(null);
            return {shareId};
        }
        if (!this.pc || !this.cfSessionId || !this.localScreenTrack) return null;

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
            this.guildVoiceSvc.closeTracks(guildId, channelId, this.cfSessionId, trackNames)
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
     * A framerate change is free — the Rust capture loop reads it each frame. A resolution change
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
        if (!started) return null;
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
        if (!this.localScreenAudioTrack) return;
        const muted = !this.localScreenAudioMuted();
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
        if (!this.cfSessionId) return;
        const trackNames = this.getActiveTrackNames();
        if (trackNames.length > 0) {
            await firstValueFrom(
                this.guildVoiceSvc.closeTracks(guildId, channelId, this.cfSessionId, trackNames)
            ).catch(() => {
            });
        }
    }

    /** Updates stream/audio state when a remote participant's track is closed by the server. */
    handleRemoteTrackClosed(trackName: string, userId: string): void {
        if (trackName === 'video') {
            this.videoStreamsSignal.update(m => {
                const n = new Map(m);
                n.delete(userId);
                return n;
            });
        } else if (trackName.startsWith('screen-audio-')) {
            // Drop the source, or a stopped stream keeps its slot in the mixer forever - silent,
            // but still popped and mixed on every frame.
            void this.voiceEngine.unsubscribe(trackName);
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
        if (!this.pc || !this.cfSessionId) return;
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        const resp = await firstValueFrom(this.guildVoiceSvc.renegotiate(guildId, channelId, this.cfSessionId, offer));
        await this.pc.setRemoteDescription(resp.sessionDescription);
    }

}
