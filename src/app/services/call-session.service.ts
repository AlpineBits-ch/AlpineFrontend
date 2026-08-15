import {inject, Injectable, signal} from '@angular/core';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {VoiceService} from './voice.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {ScreenPickerService} from './screen-picker.service';
import type {CallDto} from '../dtos/response/call.dto';
import type {ActiveCallSession, CallParticipantUi, ScreenShareUi,} from './call-session.types';
import {OAuthService} from 'angular-oauth2-oidc';
import {bitrateFor, StreamPreset} from '../models/stream-preset';
import {ScreenResumeTracker} from '../shared/call/screen-resume';
import {solveGeometry} from '../models/capture-geometry';
import {publishOptions, useRustPublisher} from './screen-publish';
import {ScreenPickerChoice} from './screen-picker.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

@Injectable({providedIn: 'root'})
export class CallSessionService {
    readonly session = signal<ActiveCallSession | null>(null);
    /**
     * Push-to-talk gate for this call, independent of the deliberate mute
     * toggle - true means "allowed to transmit". Driven by {@link CallHotkeyService};
     * stays true when no push-to-talk key is bound, so the mic is open by default.
     */
    readonly pttGateOpen = signal(true);
    /**
     * When the server has told us we are the only one left in the call, the moment it will
     * force-end it. Null whenever that does not apply.
     */
    readonly aloneDeadline = signal<Date | null>(null);
    /** Quality of the running screen share, or null when not sharing. */
    readonly screenPreset = signal<StreamPreset | null>(null);
    /**
     * Dimensions of the captured source, kept so a mid-stream resolution change re-solves from the
     * original size rather than ratcheting down from the current output geometry.
     */
    private screenSourceSize: { width: number; height: number } | null = null;
    /** True while the running share is owned by the Rust publisher rather than the webview. */
    private rustPublishing = false;
    /** The picker choice behind the running publish, so a later restart reopens the same source. */
    private rustChoice: ScreenPickerChoice | null = null;
    /**
     * Seats held for shares whose track closed and whose picture is expected back - see
     * `ScreenResumeTracker`. Keyed by share id here, because a DM call carries a real per-share id
     * and one person can hold more than one.
     */
    private readonly screenResume = new ScreenResumeTracker(shareId => this.removeScreenShare(shareId));
    /**
     * Whether the running share actually carries its own sound, and whether it is locally muted.
     *
     * `hasAudio` is what the publisher *published*, not what the picker asked for: a machine with no
     * usable loopback device shares video only, and offering a mute button for a track that does not
     * exist is worse than not offering one.
     */
    readonly localScreenHasAudio = signal(false);
    readonly localScreenAudioMuted = signal(false);
    /** The audio track Rust opened, or null for a video-only share. */
    private rustAudioTrackName: string | null = null;
    private readonly oauth = inject(OAuthService);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private profileService = inject(ProfileService);
    private conversationStore = inject(ConversationStore);
    private voiceService = inject(VoiceService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private screenPicker = inject(ScreenPickerService);
    private voiceWs = inject(VoiceWebsocketService);

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

    /**
     * Hang up: removes the local user from the call, leaving it running for everyone else.
     *
     * @param silent skip the network call because the server has already torn this session down
     *               (device takeover, or we are reacting to a `CallEnded` that already happened).
     *               Calling leave then would be a pointless, possibly-erroring request against a
     *               participant record that no longer exists.
     */
    end(silent = false): void {
        const s = this.session();
        if (!s) return;
        // Stop any active local media streams before tearing down
        s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
        s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
        // TODO(webrtc): disconnect all peer connections
        if (!silent) this.voiceService.leaveCall(s.callId).subscribe();
        // Held seats belong to the call that is ending. An expiry firing afterwards would splice a
        // session that is already gone.
        this.screenResume.clear();
        this.session.set(null);
        this.aloneDeadline.set(null);
    }

    setAloneDeadline(deadline: Date | null): void {
        this.aloneDeadline.set(deadline);
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
                // Both halves, per the contract: `tracks/close` releases the media on the SFU - the
                // publisher does that itself as it tears down - and this tells the room. Sending
                // only the close left `isStreaming` true and the viewer count scoped to a share
                // nobody was watching; sending only this leaves the track alive on the SFU, which
                // is egress we pay for. This path announced neither.
                const stoppedShareId = localShare?.shareId;
                await this.rustMedia.stopScreenPublish();
                this.rustPublishing = false;
                if (stoppedShareId && s.callId) {
                    this.voiceWs.invokeScreenShareStopped(s.callId, stoppedShareId);
                }
            } else {
                void this.rustMedia.stopScreenCapture();
            }
            this.rustChoice = null;
            this.rustAudioTrackName = null;
            this.localScreenHasAudio.set(false);
            this.localScreenAudioMuted.set(false);
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
     * Mute the sound of the share this client is publishing.
     *
     * <p>Stops packets in Rust rather than tearing down the capture device, so unmuting is instant.
     * A no-op on a video-only share - the UI reads {@link localScreenHasAudio} to decide whether to
     * offer the control at all.</p>
     */
    toggleLocalScreenAudio(): void {
        if (!this.rustAudioTrackName) return;
        const muted = !this.localScreenAudioMuted();
        void this.rustMedia.setScreenAudioMuted(muted);
        this.localScreenAudioMuted.set(muted);
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
                publishOptions(
                    choice,
                    shareId,
                    this.apiConfig.baseUrl(),
                    this.oauth.getAccessToken(),
                    await this.deviceIdentity.deviceId(),
                    {callId},
                ),
            );
            console.log(`[call] Rust publisher live on ${published.encoder}`, published);
            // The backend raises TrackPublished from `tracks/new` on its own, so peers could always
            // find the track - but nothing set `isStreaming` or opened the viewer-count scope,
            // because only the webview publish path ever announced.
            this.voiceWs.invokeScreenShareStarted(callId, shareId);
            this.rustAudioTrackName = published.audioTrackName;
            this.localScreenHasAudio.set(published.audioTrackName !== null);
            this.localScreenAudioMuted.set(false);
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
     * Change stream quality mid-share.
     *
     * <p>Only the capture side is handled here; CallWebRtcService watches {@link screenPreset} and
     * re-applies the sender encoding itself. Nothing in here restarts the publish or announces
     * anything: a framerate change is read by the capture loop on its next frame, and a resolution
     * change retypes the encoder in place, leaving the session, the track and the share id alone.</p>
     *
     * <p>A resolution change used to stop the publish and start a new one under a fresh share id,
     * which meant announcing a stop and a start and leaving every peer's tile out of the call panel
     * for as long as the new publish took to negotiate.</p>
     */
    async setScreenPreset(preset: StreamPreset): Promise<void> {
        const previous = this.screenPreset();
        if (!previous) return;
        this.screenPreset.set(preset);
        // The bar is where quality is chosen now - the pre-share dialog only picks a source - so the
        // choice has to outlive the share. See `ScreenPickerService.rememberPreset`.
        this.screenPicker.rememberPreset(preset);

        if (this.rustPublishing) {
            // Framerate is live - the capture loop re-reads it every frame.
            if (preset.framerate !== previous.framerate) {
                await this.rustMedia.setPublishFps(preset.framerate);
            }
            if (preset.resolution !== previous.resolution && this.screenSourceSize) {
                const {width, height} = this.screenSourceSize;
                const box = solveGeometry(width, height, preset.resolution);
                await this.rustMedia.setPublishGeometry(box.width, box.height, bitrateFor(preset));
            }
            // Kept in step with what the encoder is now producing, so a publish that genuinely does
            // restart later - sharing a different source - opens at the resolution being watched.
            if (this.rustChoice) this.rustChoice = {...this.rustChoice, preset};
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
        // Someone came back, so the server's force-end countdown no longer applies.
        if ((this.session()?.participants.length ?? 0) > 1) this.aloneDeadline.set(null);
    }

    onParticipantLeft(userId: string): void {
        this.session.update(s =>
            s ? {...s, participants: s.participants.filter(p => p.userId !== userId)} : s
        );
    }

    /**
     * Both of these return the *same* session object when nothing actually changed.
     *
     * They used to rebuild it unconditionally, so every call notified every reader even when the
     * value was identical. Speaking state is written many times a second, and any effect that both
     * reads the session and calls one of these becomes an infinite loop that allocates a session
     * and a participant array per pass - which is what it did: ~0.5 GB/s, and a UI that never got
     * as far as rendering the call screen.
     */
    onSpeakingChanged(userId: string, isSpeaking: boolean): void {
        this.patchParticipant(userId, p => p.isSpeaking === isSpeaking ? p : {...p, isSpeaking});
    }

    onMuteChanged(userId: string, isMuted: boolean): void {
        this.patchParticipant(userId, p => p.isMuted === isMuted ? p : {...p, isMuted});
    }

    private patchParticipant(
        userId: string,
        fn: (p: CallParticipantUi) => CallParticipantUi,
    ): void {
        this.session.update(s => {
            if (!s) return s;
            let changed = false;
            const participants = s.participants.map(p => {
                if (p.userId !== userId) return p;
                const next = fn(p);
                if (next !== p) changed = true;
                return next;
            });
            return changed ? {...s, participants} : s;
        });
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
        // Anything this person was holding a seat for has just been replaced. Dropped here rather
        // than left to expire, so the stage never briefly shows the same person twice - once frozen
        // and once live.
        const superseded = (s?.screenShares ?? [])
            .filter(sh => sh.userId === userId && sh.shareId !== shareId && sh.state === 'resuming')
            .map(sh => sh.shareId);
        for (const old of superseded) this.screenResume.cancel(old);

        this.session.update(st => {
            if (!st) return st;
            const kept = superseded.length === 0
                ? st.screenShares
                : st.screenShares.filter(sh => !superseded.includes(sh.shareId));
            const idx = kept.findIndex(sh => sh.shareId === shareId);
            if (idx !== -1) {
                const updated = [...kept];
                // `state` unconditionally, `stream` only when one came with the event: a share that
                // was being held is live again the moment it is announced, even if its track
                // arrives a beat later.
                updated[idx] = {...updated[idx], state: 'live', ...(stream ? {stream} : {})};
                return {...st, screenShares: updated};
            }
            const share: ScreenShareUi = {shareId, userId, displayName, isLocal: false, stream, state: 'live'};
            return {...st, screenShares: [...kept, share]};
        });
    }

    /**
     * A share's track ended.
     *
     * <p>Held rather than removed - see `ScreenResumeTracker`. Removing it immediately is what made
     * a source switch or a renegotiation read as the stream ending: the tile left the panel and the
     * layout closed over the gap. Expiry is what finally removes it.</p>
     */
    onScreenShareStopped(shareId: string): void {
        const share = this.session()?.screenShares.find(sh => sh.shareId === shareId);
        // A local share ends because this client ended it - there is nothing to wait for, and
        // holding a seat for our own stopped stream would be waiting on ourselves.
        if (!share || share.isLocal) {
            this.removeScreenShare(shareId);
            return;
        }
        this.screenResume.hold(shareId);
        this.session.update(s => s ? {
            ...s,
            screenShares: s.screenShares.map(sh =>
                sh.shareId === shareId ? {...sh, state: 'resuming' as const} : sh),
        } : s);
    }

    private removeScreenShare(shareId: string): void {
        this.screenResume.cancel(shareId);
        this.session.update(s =>
            s ? {...s, screenShares: s.screenShares.filter(sh => sh.shareId !== shareId)} : s
        );
    }
}
