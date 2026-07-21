import {computed, inject, Injectable, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';
import {ProfileService} from './profile.service';
import {GuildVoiceService, VoiceParticipantDto} from './guild-voice.service';
import {
    GuildWebsocketService,
    WsGuildParticipantJoined,
    WsGuildTrackClosed,
    WsGuildTrackPublished,
    WsMovedToChannel,
    WsUserJoinedVoice,
    WsUserLeftVoice,
    WsVoiceCameraChanged,
    WsVoiceDeafenChanged,
    WsVoiceMuteChanged,
    WsVoiceScreenShareStarted,
} from './guild-websocket.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceRTCService} from './voice-rtc.service';

export interface VoiceChannelParticipant {
    userId: string;
    displayName: string;
    avatarLabel: string;
    avatarUrl?: string;
    isMuted: boolean;
    isSpeaking: boolean;
    isCameraOn: boolean;
    isScreenSharing: boolean;
    isServerDeafened: boolean;
    isLocal: boolean;
    cfSessionId?: string | null;
}

export interface VoiceLocalState {
    isMuted: boolean;
    isDeafened: boolean;
    isCameraOn: boolean;
    isScreenSharing: boolean;
}

@Injectable({providedIn: 'root'})
export class VoiceChannelService {
    readonly rtc = inject(VoiceRTCService);
    readonly joinedChannelId = signal<string | null>(null);
    readonly joinedGuildId = signal<string | null>(null);
    readonly joinedChannelName = signal<string | null>(null);
    readonly joinedGuildName = signal<string | null>(null);

    // ── Public state ───────────────────────────────────────────────────────────
    readonly localState = signal<VoiceLocalState>({
        isMuted: false,
        isDeafened: false,
        isCameraOn: false,
        isScreenSharing: false
    });
    readonly isInVoice = computed(() => this.joinedChannelId() !== null);
    // Pass-through signals from VoiceRTCService for template consumption
    readonly rtcState = this.rtc.rtcState;
    readonly participantsWithAudio = this.rtc.participantsWithAudio;
    readonly localVideoStream = this.rtc.localVideoStream;
    readonly localScreenStream = this.rtc.localScreenStream;
    readonly localScreenHasAudio = this.rtc.localScreenHasAudio;
    readonly localScreenAudioMuted = this.rtc.localScreenAudioMuted;
    readonly videoStreams = this.rtc.videoStreams;
    readonly screenStreams = this.rtc.screenStreams;
    readonly screenAudioMuted = this.rtc.screenAudioMuted;
    private profileService = inject(ProfileService);
    private guildVoiceSvc = inject(GuildVoiceService);
    private guildWsSvc = inject(GuildWebsocketService);
    private soundSettings = inject(SoundSettingsService);
    private channelParticipantsSignal = signal<Map<string, VoiceChannelParticipant[]>>(new Map());
    readonly channelParticipants = this.channelParticipantsSignal.asReadonly();

    // ── Sidebar voice state cache ──────────────────────────────────────────────
    private lastLoadedGuildId: string | null = null;

    // ── Join guard ─────────────────────────────────────────────────────────────

    private pendingJoinId: string | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        // Update participant speaking state from VAD events in VoiceRTCService
        this.rtc.speakingChanges$.subscribe(({userId, isSpeaking}) => {
            const channelId = this.joinedChannelId();
            if (channelId) {
                this.patchParticipant(channelId, userId, p => p.isSpeaking === isSpeaking ? p : {...p, isSpeaking});
            }
        });

        // Auto-stop screen share when the OS ends the screen track
        this.rtc.screenEnded$.subscribe(() => {
            if (this.localState().isScreenSharing) void this.toggleScreenShare();
        });

        this.guildWsSvc.userJoinedVoiceObservable.subscribe(e => this.onUserJoinedVoice(e));
        this.guildWsSvc.userLeftVoiceObservable.subscribe(e => this.onUserLeftVoice(e));
        this.guildWsSvc.guildParticipantJoinedObservable.subscribe(e => this.onParticipantJoined(e));
        this.guildWsSvc.guildTrackPublishedObservable.subscribe(e => this.onTrackPublished(e));
        this.guildWsSvc.guildTrackClosedObservable.subscribe(e => this.onTrackClosed(e));
        this.guildWsSvc.voiceMuteChangedObservable.subscribe(e => this.onMuteChanged(e));
        this.guildWsSvc.voiceDeafenChangedObservable.subscribe(e => this.onDeafenChanged(e));
        this.guildWsSvc.voiceCameraChangedObservable.subscribe(e => this.onCameraChanged(e));
        this.guildWsSvc.voiceScreenShareStartedObservable.subscribe(e => this.onScreenShareStarted(e));
        this.guildWsSvc.voiceScreenShareStoppedObservable.subscribe(() => { /* TrackClosed handles cleanup */
        });
        this.guildWsSvc.movedToChannelObservable.subscribe(e => void this.onMovedToChannel(e));
    }

    // ── Voice state loading for sidebar ───────────────────────────────────────

    loadVoiceStatesForGuild(channels: ChannelDto[], guildId: string): void {
        if (this.lastLoadedGuildId === guildId) return;
        this.lastLoadedGuildId = guildId;

        channels
            .filter(c => c.type === ChannelType.Voice)
            .forEach(channel => {
                if (this.joinedChannelId() === channel.id) return;
                this.guildVoiceSvc.getState(guildId, channel.id).subscribe({
                    next: state => {
                        const ownId = this.profileService.ownProfile()?.userId ?? '';
                        const participants = state.participants.map(p => this.dtoToParticipant(p, ownId));
                        this.channelParticipantsSignal.update(map => {
                            const n = new Map(map);
                            n.set(channel.id, participants);
                            return n;
                        });
                    },
                    error: () => {
                    },
                });
            });
    }

    // ── Join / leave ───────────────────────────────────────────────────────────

    async joinChannel(channel: ChannelDto, guildName: string): Promise<void> {
        if (this.pendingJoinId === channel.id || this.joinedChannelId() === channel.id) return;

        const prevId = this.joinedChannelId();
        const prevGuild = this.joinedGuildId();
        this.pendingJoinId = channel.id;

        try {
            if (prevId && prevGuild) {
                await this.doLeave(prevGuild, prevId, true);
            }

            this.joinedChannelId.set(channel.id);
            this.joinedGuildId.set(channel.guildId);
            this.joinedChannelName.set(channel.name);
            this.joinedGuildName.set(guildName);
            this.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});

            try {
                const state = await firstValueFrom(this.guildVoiceSvc.join(channel.guildId, channel.id));
                const ownId = this.profileService.ownProfile()?.userId ?? '';
                const list = state.participants.map(p => this.dtoToParticipant(p, ownId));

                if (!list.find(p => p.isLocal)) {
                    const profile = this.profileService.ownProfile();
                    list.unshift({
                        userId: ownId,
                        displayName: profile?.userName ?? 'You',
                        avatarLabel: (profile?.userName?.[0] ?? 'Y').toUpperCase(),
                        avatarUrl: profile?.avatarUrl,
                        isMuted: false,
                        isSpeaking: false,
                        isCameraOn: false,
                        isScreenSharing: false,
                        isServerDeafened: false,
                        isLocal: true,
                    });
                }

                this.channelParticipantsSignal.update(map => {
                    const n = new Map(map);
                    n.set(channel.id, list);
                    return n;
                });
                this.soundSettings.playVoiceJoin();
                const connected = await this.rtc.connect(channel.guildId, channel.id, ownId);
                if (!connected) {
                    console.error('VoiceChannelService: WebRTC connect() returned false -audio setup failed');
                    await this.doLeave(channel.guildId, channel.id, false);
                    this.joinedChannelId.set(null);
                    this.joinedGuildId.set(null);
                    this.joinedChannelName.set(null);
                    this.joinedGuildName.set(null);
                    return;
                }
                this.heartbeatTimer = setInterval(() => this.guildWsSvc.invokeVoiceHeartbeat(), 30_000);
            } catch (err) {
                console.error('VoiceChannelService: join failed', err);
            }
        } finally {
            this.pendingJoinId = null;
        }
    }

    async leaveChannel(): Promise<void> {
        const channelId = this.joinedChannelId();
        const guildId = this.joinedGuildId();
        if (!channelId || !guildId) return;
        await this.doLeave(guildId, channelId, false);
        this.joinedChannelId.set(null);
        this.joinedGuildId.set(null);
        this.joinedChannelName.set(null);
        this.joinedGuildName.set(null);
        this.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});
    }

    toggleMute(): void {
        this.localState.update(s => ({...s, isMuted: !s.isMuted}));
        this.rtc.setMicEnabled(!this.localState().isMuted);
        const channelId = this.joinedChannelId();
        if (channelId) this.guildWsSvc.invokeVoiceMuteChanged(channelId, this.localState().isMuted);
        this.syncLocal();
    }

    // ── Local controls ─────────────────────────────────────────────────────────

    toggleDeafen(): void {
        this.localState.update(s => {
            const d = !s.isDeafened;
            return {...s, isDeafened: d, isMuted: d || s.isMuted};
        });
        const {isDeafened, isMuted} = this.localState();
        this.rtc.setMicEnabled(!isMuted);
        this.rtc.setDeafened(isDeafened);
        const channelId = this.joinedChannelId();
        if (channelId) {
            this.guildWsSvc.invokeVoiceDeafenChanged(channelId, isDeafened);
            this.guildWsSvc.invokeVoiceMuteChanged(channelId, isMuted);
        }
        this.syncLocal();
    }

    async toggleCamera(): Promise<void> {
        const guildId = this.joinedGuildId();
        const channelId = this.joinedChannelId();
        if (!guildId || !channelId) return;

        if (this.localState().isCameraOn) {
            await this.rtc.closeCamera(guildId, channelId);
            this.localState.update(s => ({...s, isCameraOn: false}));
            this.guildWsSvc.invokeVoiceCameraChanged(channelId, false);
        } else {
            const trackName = await this.rtc.publishCamera(guildId, channelId);
            if (trackName === null) return;
            this.localState.update(s => ({...s, isCameraOn: true}));
            this.guildWsSvc.invokeVoiceCameraChanged(channelId, true);
        }
        this.syncLocal();
    }

    async toggleScreenShare(): Promise<void> {
        const guildId = this.joinedGuildId();
        const channelId = this.joinedChannelId();
        if (!guildId || !channelId) return;

        if (this.localState().isScreenSharing) {
            const result = await this.rtc.closeScreen(guildId, channelId);
            if (result) this.guildWsSvc.invokeVoiceScreenShareStopped(channelId, result.shareId);
            this.localState.update(s => ({...s, isScreenSharing: false}));
        } else {
            const result = await this.rtc.publishScreen(guildId, channelId);
            if (!result) return;
            this.guildWsSvc.invokeVoiceScreenShareStarted(channelId, result.shareId, `screen-${result.shareId}`);
            this.localState.update(s => ({...s, isScreenSharing: true}));
        }
        this.syncLocal();
    }

    setServerDeafened(userId: string, isDeafened: boolean): void {
        const channelId = this.joinedChannelId();
        if (!channelId) return;
        this.patchParticipant(channelId, userId, p => ({
            ...p,
            isServerDeafened: isDeafened,
            isMuted: isDeafened || p.isMuted
        }));
    }

    setUserVolume(userId: string, volume: number): void {
        this.rtc.setUserVolume(userId, volume);
    }

    getUserVolume(userId: string): number {
        return this.rtc.getUserVolume(userId);
    }

    isScreenAudioMuted(userId: string): boolean {
        return this.rtc.isScreenAudioMuted(userId);
    }

    toggleScreenAudioMute(userId: string): void {
        this.rtc.toggleScreenAudioMute(userId);
    }

    toggleLocalScreenAudio(): void {
        this.rtc.toggleLocalScreenAudio();
    }

    getVideoStream(userId: string): MediaStream | null {
        return this.rtc.getVideoStream(userId);
    }

    getScreenStream(userId: string): MediaStream | null {
        return this.rtc.getScreenStream(userId);
    }

    private async doLeave(guildId: string, channelId: string, silent: boolean): Promise<void> {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.soundSettings.playVoiceLeave();
        await this.rtc.closeAllTracks(guildId, channelId);
        this.rtc.teardown();
        if (!silent) {
            await firstValueFrom(this.guildVoiceSvc.leave(guildId, channelId)).catch(() => {
            });
        }
        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(channelId, (n.get(channelId) ?? []).filter(p => !p.isLocal));
            return n;
        });
    }

    // ── SignalR event handlers ─────────────────────────────────────────────────

    private onUserJoinedVoice(e: WsUserJoinedVoice): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        if (e.userId === ownId) return;

        if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceJoin();

        const profile = this.profileService.getCachedByUserId(e.userId);
        const participant: VoiceChannelParticipant = {
            userId: e.userId,
            displayName: profile?.userName ?? e.userId,
            avatarLabel: (profile?.userName?.[0] ?? '?').toUpperCase(),
            avatarUrl: profile?.avatarUrl,
            isMuted: false,
            isSpeaking: false,
            isCameraOn: false,
            isScreenSharing: false,
            isServerDeafened: false,
            isLocal: false,
        };

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            const list = n.get(e.channelId) ?? [];
            if (!list.find(p => p.userId === e.userId)) n.set(e.channelId, [...list, participant]);
            return n;
        });
    }

    private onUserLeftVoice(e: WsUserLeftVoice): void {
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        if (e.userId === ownId) return;

        if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceLeave();

        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(e.channelId, (n.get(e.channelId) ?? []).filter(p => p.userId !== e.userId));
            return n;
        });

        this.rtc.cleanupParticipant(e.userId);
    }

    private onParticipantJoined(e: WsGuildParticipantJoined): void {
        if (e.channelId !== this.joinedChannelId()) return;
        this.patchParticipant(e.channelId, e.userId, p => ({...p, cfSessionId: e.cfSessionId}));

        const guildId = this.joinedGuildId();
        if (guildId) {
            void this.rtc.subscribeAudio(guildId, e.channelId, [{
                userId: e.userId, cfSessionId: e.cfSessionId, trackName: e.audioTrackName,
            }]);
        }
    }

    private onTrackPublished(e: WsGuildTrackPublished): void {
        if (e.channelId !== this.joinedChannelId()) return;
        const guildId = this.joinedGuildId();
        if (!guildId) return;

        if (e.kind === 'screenAudio') {
            void this.rtc.subscribeAudio(guildId, e.channelId, [{
                userId: e.userId, cfSessionId: e.cfSessionId, trackName: e.trackName, kind: 'screenAudio',
            }]);
        } else {
            void this.rtc.subscribeVideo(guildId, e.channelId, e.userId, e.cfSessionId, e.trackName,
                e.kind === 'screen' ? 'screen' : 'video');
        }
    }

    private onTrackClosed(e: WsGuildTrackClosed): void {
        if (e.channelId !== this.joinedChannelId()) return;
        this.rtc.handleRemoteTrackClosed(e.trackName, e.userId);
        if (e.trackName === 'video') {
            this.patchParticipant(e.channelId, e.userId, p => ({...p, isCameraOn: false}));
        } else if (e.trackName.startsWith('screen-') && !e.trackName.startsWith('screen-audio-')) {
            this.patchParticipant(e.channelId, e.userId, p => ({...p, isScreenSharing: false}));
        }
    }

    private onMuteChanged(e: WsVoiceMuteChanged): void {
        this.patchParticipant(e.channelId, e.userId, p => ({...p, isMuted: e.isMuted}));
    }

    private onDeafenChanged(e: WsVoiceDeafenChanged): void {
        if (e.isDeafened) this.patchParticipant(e.channelId, e.userId, p => ({...p, isMuted: true}));
    }

    private onCameraChanged(e: WsVoiceCameraChanged): void {
        this.patchParticipant(e.channelId, e.userId, p => ({...p, isCameraOn: e.isCameraOn}));
    }

    private onScreenShareStarted(e: WsVoiceScreenShareStarted): void {
        this.patchParticipant(e.channelId, e.userId, p => ({...p, isScreenSharing: true}));
    }

    private async onMovedToChannel(e: WsMovedToChannel): Promise<void> {
        const pseudo: ChannelDto = {
            id: e.channelId, guildId: e.guildId, name: 'Voice Channel',
            type: ChannelType.Voice, createdAt: new Date(), updatedAt: new Date(),
            description: '', isAgeRestricted: false, isPrivate: false,
            categoryId: undefined, permissions: [], position: 0,
        };
        await this.joinChannel(pseudo, this.joinedGuildName() ?? '');
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private syncLocal(): void {
        const channelId = this.joinedChannelId();
        if (!channelId) return;
        const ownId = this.profileService.ownProfile()?.userId ?? '';
        const {isMuted, isCameraOn, isScreenSharing} = this.localState();
        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            n.set(channelId, (n.get(channelId) ?? []).map(p =>
                p.userId === ownId ? {...p, isMuted, isCameraOn, isScreenSharing} : p,
            ));
            return n;
        });
    }

    private patchParticipant(
        channelId: string,
        userId: string,
        fn: (p: VoiceChannelParticipant) => VoiceChannelParticipant,
    ): void {
        this.channelParticipantsSignal.update(map => {
            const n = new Map(map);
            const list = n.get(channelId);
            if (list) n.set(channelId, list.map(p => p.userId === userId ? fn(p) : p));
            return n;
        });
    }

    private dtoToParticipant(dto: VoiceParticipantDto, ownId: string): VoiceChannelParticipant {
        const profile = this.profileService.getCachedByUserId(dto.userId);
        return {
            userId: dto.userId,
            displayName: profile?.userName ?? dto.userId,
            avatarLabel: (profile?.userName?.[0] ?? '?').toUpperCase(),
            avatarUrl: profile?.avatarUrl,
            isMuted: dto.isSelfMuted || dto.isServerMuted,
            isSpeaking: false,
            isCameraOn: false,
            isScreenSharing: dto.isStreaming,
            isServerDeafened: dto.isServerDeafened,
            isLocal: dto.userId === ownId,
            cfSessionId: dto.cfSessionId,
        };
    }
}
