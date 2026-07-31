import {inject, Injectable, signal} from '@angular/core';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {VoiceService} from './voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import type {CallDto} from '../dtos/response/call.dto';
import type {ActiveCallSession, CallParticipantUi, ScreenShareUi,} from './call-session.types';
import {OAuthService} from 'angular-oauth2-oidc';
import {StreamPreset} from '../models/stream-preset';
import {solveGeometry} from '../models/capture-geometry';
import {publishOptions, useRustPublisher} from './screen-publish';
import {ScreenPickerChoice} from './screen-picker.service';
import {ApiConfigService} from './api-config.service';

@Injectable({providedIn: 'root'})
export class CallSessionService {
    readonly session = signal<ActiveCallSession | null>(null);
    /**
     * Push-to-talk gate for this call, independent of the deliberate mute
     * toggle - true means "allowed to transmit". Driven by {@link CallHotkeyService};
     * stays true when no push-to-talk key is bound, so the mic is open by default.
     */
    readonly pttGateOpen = signal(true);
    /** Quality of the running screen share, or null when not sharing. */
    readonly screenPreset = signal<StreamPreset | null>(null);
    /**
     * Dimensions of the captured source, kept so a mid-stream resolution change re-solves from the
     * original size rather than ratcheting down from the current output geometry.
     */
    private screenSourceSize: { width: number; height: number } | null = null;
    /** True while the running share is owned by the Rust publisher rather than the webview. */
    private rustPublishing = false;
    /** The picker choice behind the running publish, so a resolution change can rebuild it. */
    private rustChoice: ScreenPickerChoice | null = null;
    private readonly oauth = inject(OAuthService);
    private readonly apiConfig = inject(ApiConfigService);
    private profileService = inject(ProfileService);
    private conversationStore = inject(ConversationStore);
    private voiceService = inject(VoiceService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private screenPicker = inject(ScreenPickerService);

    // ── Lifecycle ────────────────────────────────────────────────────────────

    join(callDto: CallDto, conversationId: string): void {
        const ownId = this.profileService.ownProfile()?.userId;
        const conv = this.conversationStore.entities().find(c => c.id === conversationId);

        const participants: CallParticipantUi[] = callDto.participants.map(p => {
            const member = conv?.members.find(m => m.userId === p.userId);
            const profile = this.profileService.getCachedByUserId(p.userId);
            return {
                userId: p.userId,
                displayName: member?.cachedUserName ?? profile?.userName ?? 'Unknown',
                avatarLabel: (member?.cachedUserName?.[0] ?? '?').toUpperCase(),
                avatarUrl: profile?.avatarUrl,
                isLocal: p.userId === ownId,
                isMuted: false,
                isSpeaking: false,
                isCameraOn: false,
                videoStream: undefined,
            };
        });

        this.session.set({
            callId: callDto.id,
            conversationId,
            participants,
            screenShares: [],
            local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
            startedAt: new Date(),
        });

        // TODO(webrtc): inject CallWebRtcService and call .connect(callDto, conversationId)
    }

    end(): void {
        const s = this.session();
        if (!s) return;
        // Stop any active local media streams before tearing down
        s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
        s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
        // TODO(webrtc): disconnect all peer connections
        this.voiceService.endCall(s.callId).subscribe();
        this.session.set(null);
    }

    // ── Local controls ───────────────────────────────────────────────────────

    toggleMute(): void {
        this.session.update(s => {
            if (!s) return s;
            return {...s, local: {...s.local, isMuted: !s.local.isMuted}};
        });
        // TODO(webrtc): mute/unmute local audio track
    }

    /** Push-to-talk gate, set by {@link CallHotkeyService} as the key is held/released. */
    setPttGateOpen(open: boolean): void {
        this.pttGateOpen.set(open);
    }

    toggleDeafen(): void {
        this.session.update(s => {
            if (!s) return s;
            const isDeafened = !s.local.isDeafened;
            return {...s, local: {...s.local, isDeafened, isMuted: isDeafened ? true : s.local.isMuted}};
        });
        // TODO(webrtc): pause/resume all remote audio tracks
    }

    async toggleCamera(): Promise<void> {
        const s = this.session();
        if (!s) return;

        const localP = s.participants.find(p => p.isLocal);

        if (s.local.isCameraOn) {
            localP?.videoStream?.getTracks().forEach(t => t.stop());
            this.session.update(st => st ? {
                ...st,
                participants: st.participants.map(p =>
                    p.isLocal ? {...p, isCameraOn: false, videoStream: undefined} : p
                ),
                local: {...st.local, isCameraOn: false},
            } : st);
            // TODO(webrtc): remove video track from peer connections
        } else {
            let stream: MediaStream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({video: true, audio: false});
            } catch {
                return; // User denied or device unavailable
            }
            this.session.update(st => st ? {
                ...st,
                participants: st.participants.map(p =>
                    p.isLocal ? {...p, isCameraOn: true, videoStream: stream} : p
                ),
                local: {...st.local, isCameraOn: true},
            } : st);
            // TODO(webrtc): add video track to peer connections
        }
    }

    async toggleScreenShare(): Promise<void> {
        const s = this.session();
        if (!s) return;

        if (s.local.isSharing) {
            const localShare = s.screenShares.find(sh => sh.isLocal);
            localShare?.stream?.getTracks().forEach(t => t.stop());
            if (this.rustPublishing) {
                // The publisher owns its own session and closes its own tracks.
                await this.rustMedia.stopScreenPublish();
                this.rustPublishing = false;
            } else {
                void this.rustMedia.stopScreenCapture();
            }
            this.rustChoice = null;
            this.screenPreset.set(null);
            this.screenSourceSize = null;
            this.session.update(st => st ? {
                ...st,
                screenShares: st.screenShares.filter(sh => !sh.isLocal),
                local: {...st.local, isSharing: false},
            } : st);
            // TODO(webrtc): remove screen share track from peer connections
        } else {
            // Show custom Rust-based screen picker instead of the system picker
            const choice = await this.screenPicker.show();
            if (!choice) return;

            const {sourceId, preset, sourceWidth, sourceHeight} = choice;
            const shareId = crypto.randomUUID();
            const ownId = this.profileService.ownProfile()?.userId ?? '';

            if (useRustPublisher()) {
                await this.startRustPublish(choice, shareId, ownId);
                return;
            }

            // Solved once, before capture starts, and held for the session.
            const geometry = solveGeometry(sourceWidth, sourceHeight, preset.resolution);
            let videoTrack: MediaStreamTrack;
            try {
                videoTrack = await this.rustMedia.startScreenCapture(sourceId, geometry, preset.framerate);
            } catch {
                return;
            }
            this.screenPreset.set(preset);
            this.screenSourceSize = {width: sourceWidth, height: sourceHeight};

            const stream = new MediaStream([videoTrack]);

            videoTrack.onended = () => {
                this.session.update(st => st ? {
                    ...st,
                    screenShares: st.screenShares.filter(sh => sh.shareId !== shareId),
                    local: {...st.local, isSharing: false},
                } : st);
            };

            this.session.update(st => st ? {
                ...st,
                screenShares: [...st.screenShares, {shareId, userId: ownId, displayName: 'You', isLocal: true, stream}],
                local: {...st.local, isSharing: true},
            } : st);
            // TODO(webrtc): add display media track to peer connections
        }
    }

    /**
     * Publish the screen from Rust, on its own Cloudflare session.
     *
     * CallWebRtcService watches the session's local share for a stream to publish; there is none
     * here by design, so it leaves the peer connection alone and the track reaches the other side
     * through the publisher's own session.
     */
    private async startRustPublish(
        choice: ScreenPickerChoice,
        shareId: string,
        ownId: string,
    ): Promise<void> {
        const callId = this.session()?.callId;
        if (!callId) return;

        try {
            const published = await this.rustMedia.startScreenPublish(
                publishOptions(choice, shareId, this.apiConfig.baseUrl(), this.oauth.getAccessToken(), {
                    callId,
                }),
            );
            console.log(`[call] Rust publisher live on ${published.encoder}`, published);
        } catch (e) {
            console.error('[call] Rust publish failed', e);
            return;
        }

        this.screenPreset.set(choice.preset);
        this.screenSourceSize = {width: choice.sourceWidth, height: choice.sourceHeight};
        this.rustPublishing = true;
        this.rustChoice = choice;
        this.session.update(st => st ? {
            ...st,
            screenShares: [...st.screenShares, {
                shareId, userId: ownId, displayName: 'You', isLocal: true, stream: undefined,
            }],
            local: {...st.local, isSharing: true},
        } : st);
    }

    /**
     * Rebuild the publish at a new resolution.
     *
     * The encoder is fixed to one geometry, so this restarts the publish. The share is replaced in
     * session state under a new id, and CallWebRtcService's TrackPublished flow carries the new
     * session to the other side.
     */
    private async restartRustPublish(preset: StreamPreset): Promise<void> {
        const choice = this.rustChoice;
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        if (!choice) return;

        await this.rustMedia.stopScreenPublish();
        this.rustPublishing = false;
        this.session.update(st => st ? {
            ...st,
            screenShares: st.screenShares.filter(sh => !sh.isLocal),
        } : st);

        await this.startRustPublish({...choice, preset}, crypto.randomUUID(), ownId);
    }

    /**
     * Change stream quality mid-share.
     *
     * Only the capture side is handled here; CallWebRtcService watches {@link screenPreset} and
     * re-applies the sender encoding itself. A framerate change is free - the Rust capture loop
     * reads it each frame - while a resolution change costs one renegotiation and keyframe.
     */
    async setScreenPreset(preset: StreamPreset): Promise<void> {
        const previous = this.screenPreset();
        if (!previous) return;
        this.screenPreset.set(preset);

        if (this.rustPublishing) {
            // Framerate is live - the capture loop re-reads it every frame.
            if (preset.framerate !== previous.framerate) {
                await this.rustMedia.setPublishFps(preset.framerate);
            }
            // Resolution and bitrate are baked into the encoder at construction, so a change means
            // tearing the publish down and starting a fresh one.
            if (preset.resolution !== previous.resolution && this.rustChoice) {
                await this.restartRustPublish(preset);
            }
            return;
        }

        if (preset.framerate !== previous.framerate) {
            await this.rustMedia.setCaptureFps(preset.framerate);
        }
        if (preset.resolution !== previous.resolution && this.screenSourceSize) {
            const {width, height} = this.screenSourceSize;
            await this.rustMedia.setCaptureGeometry(solveGeometry(width, height, preset.resolution));
        }
    }

    joinScreenShare(_shareId: string): void {
        // TODO(webrtc): subscribe to the remote MediaStream identified by shareId
    }

    // ── Remote participant events -called by WebRTC service ─────────────────

    onParticipantJoined(userId: string): void {
        const s = this.session();
        if (!s || s.participants.some(p => p.userId === userId)) return;

        const conv = this.conversationStore.entities().find(c => c.id === s.conversationId);
        const member = conv?.members.find(m => m.userId === userId);
        const profile = this.profileService.getCachedByUserId(userId);
        const ownId = this.profileService.ownProfile()?.userId;

        const participant: CallParticipantUi = {
            userId,
            displayName: member?.cachedUserName ?? profile?.userName ?? 'Unknown',
            avatarLabel: (member?.cachedUserName?.[0] ?? '?').toUpperCase(),
            avatarUrl: profile?.avatarUrl,
            isLocal: userId === ownId,
            isMuted: false,
            isSpeaking: false,
            isCameraOn: false,
            videoStream: undefined,
        };

        this.session.update(st => st ? {...st, participants: [...st.participants, participant]} : st);
    }

    onParticipantLeft(userId: string): void {
        this.session.update(s =>
            s ? {...s, participants: s.participants.filter(p => p.userId !== userId)} : s
        );
    }

    onSpeakingChanged(userId: string, isSpeaking: boolean): void {
        this.session.update(s => s ? {
            ...s,
            participants: s.participants.map(p => p.userId === userId ? {...p, isSpeaking} : p),
        } : s);
    }

    onMuteChanged(userId: string, isMuted: boolean): void {
        this.session.update(s => s ? {
            ...s,
            participants: s.participants.map(p => p.userId === userId ? {...p, isMuted} : p),
        } : s);
    }

    // WebRTC will call this with the remote video stream once peer connection is established
    onCameraChanged(userId: string, isCameraOn: boolean, videoStream?: MediaStream): void {
        this.session.update(s => s ? {
            ...s,
            participants: s.participants.map(p =>
                p.userId === userId ? {...p, isCameraOn, videoStream: videoStream ?? p.videoStream} : p
            ),
        } : s);
    }

    // WebRTC will call this with the remote screen share stream
    onScreenShareStarted(shareId: string, userId: string, stream?: MediaStream): void {
        const s = this.session();
        const conv = this.conversationStore.entities().find(c => c.id === s?.conversationId);
        const displayName = conv?.members.find(m => m.userId === userId)?.cachedUserName ?? 'Unknown';
        this.session.update(st => {
            if (!st) return st;
            const idx = st.screenShares.findIndex(sh => sh.shareId === shareId);
            if (idx !== -1) {
                if (!stream) return st;
                const updated = [...st.screenShares];
                updated[idx] = {...updated[idx], stream};
                return {...st, screenShares: updated};
            }
            const share: ScreenShareUi = {shareId, userId, displayName, isLocal: false, stream};
            return {...st, screenShares: [...st.screenShares, share]};
        });
    }

    onScreenShareStopped(shareId: string): void {
        this.session.update(s =>
            s ? {...s, screenShares: s.screenShares.filter(sh => sh.shareId !== shareId)} : s
        );
    }
}
