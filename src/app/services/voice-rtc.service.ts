import {effect, inject, Injectable, signal} from '@angular/core';
import {firstValueFrom, Observable, Subject} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {environment} from '../../environments/environment';
import {ApiConfigService} from "./api-config.service";

export interface VoiceSpeakingChange {
    userId: string;
    isSpeaking: boolean;
}

@Injectable({providedIn: 'root'})
export class VoiceRTCService {
    private apiConfig = inject(ApiConfigService);

    readonly rtcState = signal<RTCPeerConnectionState>('new');
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

    private localAudioTrack: MediaStreamTrack | null = null;
    private localVideoTrack: MediaStreamTrack | null = null;
    private localScreenTrack: MediaStreamTrack | null = null;
    private localScreenAudioTrack: MediaStreamTrack | null = null;
    private screenShareId: string | null = null;

    private cfAudioTrackName: string | null = null;
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

    constructor() {
        effect(() => {
            const s = this.audioSettings.settings();
            const screenFps = s.screenVideoBitrate >= 8000 ? 30 : 15;
            void this.applyBitrate(this.localSenders.get('audio'), s.audioBitrate);
            void this.applyBitrate(this.localSenders.get('video'), s.videoBitrate);
            void this.applyBitrate(this.localSenders.get('screenVideo'), s.screenVideoBitrate, screenFps);
            void this.applyBitrate(this.localSenders.get('screenAudio'), s.screenAudioBitrate);
        });
    }

    // ── Connection setup / teardown ────────────────────────────────────────────

    async connect(guildId: string, channelId: string, ownUserId: string): Promise<boolean> {
        this.setupDone = false;


        // Block the negotiation queue until the initial publish completes so that
        // GuildParticipantJoined WS events don't try to subscribe before the base
        // offer/answer is done.
        let releaseQueue!: () => void;
        this.negotiationChain = new Promise<void>(resolve => {
            releaseQueue = resolve;
        });

        try {
            // Get audio first -if mic is unavailable there's no point creating a PC.
            let audioTrack: MediaStreamTrack;
            try {
                const s = this.audioSettings.settings();
                const useRust = s.enhancedNoiseSuppression || await this.rustMedia.shouldUseRustAudio();
                console.log(`[voice] audio path: ${useRust ? 'rust' : 'getUserMedia'} (enhancedNS=${s.enhancedNoiseSuppression} micId=${s.micId})`);

                if (useRust) {
                    try {
                        audioTrack = await this.rustMedia.startMicCapture({
                            deviceId: s.micId === 'default' ? null : s.micId,
                            noiseSuppression: s.noiseSuppression,
                            autoGainControl: s.autoGainControl,
                            vadThreshold: s.vadStrength,
                        });
                        console.log('[voice] Rust mic capture started');
                    } catch (rustErr) {
                        console.warn('[voice] Rust audio capture failed, falling back to getUserMedia:', rustErr);
                        const stream = await navigator.mediaDevices.getUserMedia({
                            audio: await this.audioSettings.buildAudioConstraint(),
                            video: false,
                        });
                        audioTrack = stream.getAudioTracks()[0];
                        console.log('[voice] getUserMedia fallback succeeded, track:', audioTrack.label);
                    }
                } else {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: await this.audioSettings.buildAudioConstraint(),
                        video: false,
                    });
                    audioTrack = stream.getAudioTracks()[0];
                    console.log('[voice] getUserMedia track:', audioTrack.label);
                }
            } catch (e) {
                console.log(e)
                console.log('ERROR SETTING UP PC')
                this.setupDone = true;
                return false;
            }

            this.pc = new RTCPeerConnection({iceServers: environment.iceServers, bundlePolicy: 'max-bundle'});
            this.pc.ontrack = e => this.handleRemoteTrack(e);
            this.pc.onconnectionstatechange = () => {
                console.log('on change', this.pc);
                if (this.pc) this.rtcState.set(this.pc.connectionState);
            };

            const localStream = new MediaStream([audioTrack]);
            this.localAudioTrack = localStream.getAudioTracks()[0];
            this.setupVAD('local', ownUserId, localStream);

            const sender = this.pc.addTrack(this.localAudioTrack, localStream);
            this.localSenders.set('audio', sender);

            const {cfSessionId} = await firstValueFrom(this.guildVoiceSvc.createSession(guildId, channelId));
            this.cfSessionId = cfSessionId;

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const audioMid = this.pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';

            const publishResp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
                cfSessionId,
                sessionDescription: this.pc.localDescription!,
                tracks: [{location: 'local', mid: audioMid, trackName: 'audio'}],
            }));

            this.cfAudioTrackName = publishResp.tracks[0]?.trackName ?? 'audio';
            await this.pc.setRemoteDescription(publishResp.sessionDescription);
            if (publishResp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
            await this.applyBitrate(sender, this.audioSettings.settings().audioBitrate);

            this.setupDone = true;
            return true;

        } catch (e) {
            console.log(e)
            throw e
        } finally {
            releaseQueue();
        }
    }

    /** Returns the names of all currently published local tracks (for the close-tracks API call). */
    getActiveTrackNames(): string[] {
        const names: string[] = [];
        if (this.cfAudioTrackName) names.push(this.cfAudioTrackName);
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

        this.localAudioTrack?.stop();
        void this.rustMedia.stopMicCapture();
        this.localVideoTrack?.stop();
        this.localScreenTrack?.stop();
        void this.rustMedia.stopScreenCapture();
        this.localScreenAudioTrack?.stop();

        this.localAudioTrack = null;
        this.localVideoTrack = null;
        this.localScreenTrack = null;
        this.localScreenAudioTrack = null;
        this.screenShareId = null;

        this.pc?.close();
        this.rtcState.set('new');
        this.participantsWithAudio.set(new Set());
        this.userVolumes.clear();
        this.pc = null;
        this.cfSessionId = null;
        this.cfAudioTrackName = null;
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
            // Prefer VP9 on the receive side for the same efficiency gains.
            const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
            const ordered = [
                ...caps.filter(c => c.mimeType === 'video/VP9'),
                ...caps.filter(c => c.mimeType === 'video/H264'),
                ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
            ];
            if (ordered.length) try {
                transceiver.setCodecPreferences(ordered);
            } catch {
            }

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

    setMicEnabled(enabled: boolean): void {
        if (this.localAudioTrack) this.localAudioTrack.enabled = enabled;
    }

    setDeafened(isDeafened: boolean): void {
        this._isDeafened = isDeafened;
        this.remoteAudioEls.forEach((a, userId) => {
            a.volume = isDeafened ? 0 : (this.userVolumes.get(userId) ?? 1);
        });
    }

    async publishCamera(guildId: string, channelId: string): Promise<string | null> {
        if (!this.pc || !this.cfSessionId) return null;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: false});
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
                await this.applyBitrate(sender, this.audioSettings.settings().videoBitrate);
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
            const sourceId = await this.screenPicker.show();
            if (!sourceId) return null;

            const fps = Math.round(this.audioSettings.settings().screenVideoBitrate >= 8000 ? 30 : 15);
            const videoTrack = await this.rustMedia.startScreenCapture(sourceId, fps);
            this.localScreenTrack = videoTrack;
            this.localScreenStream.set(new MediaStream([videoTrack]));

            let audioTrack: MediaStreamTrack | null = null;
            try {
                audioTrack = await this.rustMedia.startLoopbackCapture();
            } catch {
                console.warn('[ScreenShare] Loopback audio unavailable');
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
                if (videoTransceiver) {
                    const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
                    const ordered = [
                        ...caps.filter(c => c.mimeType === 'video/VP9'),
                        ...caps.filter(c => c.mimeType === 'video/H264'),
                        ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
                    ];
                    if (ordered.length) try {
                        videoTransceiver.setCodecPreferences(ordered);
                    } catch {
                    }
                }

                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);

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
                await this.applyBitrate(videoSender, this.audioSettings.settings().screenVideoBitrate, fps);
                this.localSenders.set('screenVideo', videoSender);
                if (audioSender) {
                    await this.applyBitrate(audioSender, this.audioSettings.settings().screenAudioBitrate);
                    this.localSenders.set('screenAudio', audioSender);
                }
            });

            return {shareId};
        } catch {
            return null;
        }
    }

    async closeScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
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
        this.localSenders.delete('screenVideo');
        this.localSenders.delete('screenAudio');
        this.localScreenStream.set(null);
        this.localScreenHasAudio.set(false);
        this.localScreenAudioMuted.set(false);

        return {shareId};
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
                this.setupVAD(meta.userId, meta.userId, stream);
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

    private setupVAD(handle: string, userId: string, stream: MediaStream): void {
        try {
            const ctx = new AudioContext();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);

            const id = setInterval(() => {
                analyser.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                const speaking = avg > 20;
                this.speakingChanges$.next({userId, isSpeaking: speaking});
            }, 100);

            const prev = this.vadHandles.get(handle);
            if (prev) clearInterval(prev);
            this.vadHandles.set(handle, id);
        } catch { /* AudioContext unavailable */
        }
    }

    private async applyBitrate(sender: RTCRtpSender | undefined, kbps: number, maxFps?: number): Promise<void> {
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = kbps * 1000;
            if (maxFps !== undefined) params.encodings[0].maxFramerate = maxFps;
            await sender.setParameters(params);
        } catch { /* setParameters not supported or call already ended */
        }
    }
}
