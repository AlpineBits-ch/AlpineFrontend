import {computed, inject, Injectable, signal} from '@angular/core';
import {firstValueFrom, Subject} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {environment} from '../../environments/environment';
import {ApiConfigService} from "./api-config.service";
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
    readonly speakingChanges$ = new Subject<VoiceSpeakingChange>();
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

    // Maps a remote transceiver MID → { userId, kind }
    private midMeta = new Map<string, { userId: string; kind: 'audio' | 'video' | 'screen' | 'screenAudio' }>();

    // Audio playback elements -WebView2/Tauri requires explicit <audio> elements
    private remoteAudioEls = new Map<string, HTMLAudioElement>();
    private remoteScreenAudioEls = new Map<string, HTMLAudioElement>();

    // Per-user volume overrides (0–1.0)
    private readonly userVolumes = new Map<string, number>();

    // Track local senders so bitrate can be changed on the fly
    private readonly localSenders = new Map<string, RTCRtpSender>();

    // VAD interval handles keyed by userId (or 'local')
    private vadHandles = new Map<string, ReturnType<typeof setInterval>>();

    // Mirrors the deafen state from VoiceChannelService so new audio elements are
    // initialised with the correct volume without creating a circular dependency.
    private _isDeafened = false;

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

        // Block the negotiation queue until the session exists, so that GuildParticipantJoined WS
        // events don't try to subscribe before there is a session to subscribe on.
        let releaseQueue!: () => void;
        this.negotiationChain = new Promise<void>(resolve => {
            releaseQueue = resolve;
        });

        try {
            // Start the microphone first - if it is unavailable there is no point creating a PC.
            //
            // Capture, processing and publishing all happen in Rust, on its own Cloudflare session.
            // Nothing is added to this peer connection: other clients learn the track from the
            // ParticipantJoined event the backend emits when that session publishes "audio", and it
            // carries the Rust session id.
            try {
                await this.voiceEngine.start(
                    {kind: 'guild', guildId, channelId},
                    this.apiConfig.baseUrl(),
                    this.oauth.getAccessToken(),
                );
                this.engineUp.set(true);
            } catch (e) {
                console.error('[voice] Rust voice engine failed to start', e);
                this.setupDone = true;
                return false;
            }

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
        this.vadHandles.forEach(h => clearInterval(h));
        this.vadHandles.clear();

        this.remoteAudioEls.forEach(a => {
            a.pause();
            a.srcObject = null;
        });
        this.remoteAudioEls.clear();
        this.remoteScreenAudioEls.forEach(a => {
            a.pause();
            a.srcObject = null;
        });
        this.remoteScreenAudioEls.clear();
        this.localSenders.clear();

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
        this.userVolumes.clear();
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
        const audio = this.remoteAudioEls.get(userId);
        if (audio) {
            audio.pause();
            audio.srcObject = null;
            this.remoteAudioEls.delete(userId);
        }

        const screenAudio = this.remoteScreenAudioEls.get(userId);
        if (screenAudio) {
            screenAudio.pause();
            screenAudio.srcObject = null;
            this.remoteScreenAudioEls.delete(userId);
        }

        const vad = this.vadHandles.get(userId);
        if (vad) {
            clearInterval(vad);
            this.vadHandles.delete(userId);
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

    subscribeAudio(
        guildId: string,
        channelId: string,
        targets: { userId: string; cfSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' }[],
    ): Promise<void> {
        return this.enqueueNegotiation(async () => {
            if (!this.pc || !this.cfSessionId) return;

            const entries = targets.map(t => ({
                ...t,
                kind: t.kind ?? ('audio' as const),
                transceiver: this.pc!.addTransceiver('audio', {direction: 'recvonly'}),
            }));

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
                cfSessionId: this.cfSessionId,
                sessionDescription: this.pc.localDescription!,
                tracks: entries.map(e => ({
                    location: 'remote' as const,
                    trackName: e.trackName,
                    sessionId: e.cfSessionId,
                })),
            }));

            resp.tracks.forEach((t, i) => {
                if (t.mid && entries[i]) {
                    this.midMeta.set(t.mid, {userId: entries[i].userId, kind: entries[i].kind});
                }
            });

            await this.pc.setRemoteDescription(resp.sessionDescription);
            if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
        });
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

    setDeafened(isDeafened: boolean): void {
        this._isDeafened = isDeafened;
        this.remoteAudioEls.forEach((a, userId) => {
            a.volume = isDeafened ? 0 : (this.userVolumes.get(userId) ?? 1);
        });
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
                publishOptions(choice, shareId, this.apiConfig.baseUrl(), this.oauth.getAccessToken(), {
                    guildId,
                    channelId,
                }),
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

    setUserVolume(userId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.userVolumes.set(userId, clamped);
        const audio = this.remoteAudioEls.get(userId);
        if (audio && !this._isDeafened) audio.volume = clamped;
    }

    getUserVolume(userId: string): number {
        return this.userVolumes.get(userId) ?? 1;
    }

    isScreenAudioMuted(userId: string): boolean {
        return this.screenAudioMutedSignal().has(userId);
    }

    toggleScreenAudioMute(userId: string): void {
        const willMute = !this.screenAudioMutedSignal().has(userId);
        const audio = this.remoteScreenAudioEls.get(userId);
        if (audio) audio.volume = willMute ? 0 : 1;
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
            const audio = this.remoteScreenAudioEls.get(userId);
            if (audio) {
                audio.pause();
                audio.srcObject = null;
                this.remoteScreenAudioEls.delete(userId);
            }
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
        console.log(event);
        const mid = event.transceiver.mid;
        if (!mid) return;
        const meta = this.midMeta.get(mid);
        if (!meta) return;

        const stream = event.streams[0] ?? new MediaStream([event.track]);

        if (meta.kind === 'audio' || meta.kind === 'screenAudio') {
            const elMap = meta.kind === 'screenAudio' ? this.remoteScreenAudioEls : this.remoteAudioEls;

            let audio = elMap.get(meta.userId);
            if (!audio) {
                audio = new Audio();
                audio.autoplay = true;
                elMap.set(meta.userId, audio);
            } else {
                audio.pause();
            }
            audio.srcObject = stream;
            audio.volume = meta.kind === 'audio'
                ? (this._isDeafened ? 0 : (this.userVolumes.get(meta.userId) ?? 1))
                : (this.screenAudioMutedSignal().has(meta.userId) ? 0 : 1);

            void this.routeToSelectedSpeaker(audio);
            void audio.play().catch(() => {
            });

            if (meta.kind === 'audio') {
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.add(meta.userId);
                    return n;
                });
                this.setupVAD(meta.userId, stream);
            }
        } else if (meta.kind === 'video') {
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

    /**
     * Point a remote-audio element at the selected speaker (best-effort).
     *
     * The stored `speakerId` is a platform device name, so it has to be resolved
     * to a web sink id first -handing the raw name to `setSinkId` throws
     * `NotFoundError`. An unresolvable or dead device just leaves the element on
     * the system default.
     */
    private async routeToSelectedSpeaker(el: HTMLAudioElement): Promise<void> {
        const setSinkId = (el as HTMLAudioElement & {
            setSinkId?: (id: string) => Promise<void>
        }).setSinkId;
        if (typeof setSinkId !== 'function') return;

        const sinkId = await this.audioSettings.resolveSpeakerSinkId();
        if (!sinkId) return;
        try {
            await setSinkId.call(el, sinkId);
        } catch (e) {
            console.warn('[voice] setSinkId failed; using the default output', e);
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

    /**
     * Drive a remote participant's speaking indicator from their incoming audio.
     *
     * Only ever remote now. The local speaking state comes from the Rust gate, which is the same
     * decision that picks what actually gets transmitted - so the indicator and the transmission
     * can no longer disagree, which they routinely did when a separate WebAudio analyser made its
     * own judgement about the same microphone.
     */
    private setupVAD(userId: string, stream: MediaStream): void {
        try {
            const ctx = new AudioContext();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            // Time-domain RMS, not getByteFrequencyData averaged across every FFT bin - most of
            // those 128 bins carry no voice energy (speech sits in a handful of low bins), so that
            // average was diluted to ~1/4 of what the old MAX_VAD_AVG=60 assumed.
            const data = new Float32Array(analyser.fftSize);
            const REMOTE_THRESHOLD = 0.02;

            const id = setInterval(() => {
                analyser.getFloatTimeDomainData(data);
                const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
                this.speakingChanges$.next({userId, isSpeaking: rms > REMOTE_THRESHOLD});
            }, 50);

            const prev = this.vadHandles.get(userId);
            if (prev) clearInterval(prev);
            this.vadHandles.set(userId, id);
        } catch { /* AudioContext unavailable */
        }
    }

}
