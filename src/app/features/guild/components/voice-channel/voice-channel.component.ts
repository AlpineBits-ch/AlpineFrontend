import {Component, computed, effect, inject, input, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {firstValueFrom} from 'rxjs';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../services/voice-channel.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {RustMediaService, StreamResolution} from '../../../../services/rust-media.service';
import {VoiceChannelLobbyComponent} from './voice-channel-lobby.component';
import {CallContextMenuComponent} from '../../../../shared/call/call-context-menu/call-context-menu.component';
import {
  CallParticipantTileComponent
} from '../../../../shared/call/call-participant-tile/call-participant-tile.component';
import {CallControlsBarComponent} from '../../../../shared/call/call-controls-bar/call-controls-bar.component';
import {CallScreenLayoutComponent} from '../../../../shared/call/call-screen-layout/call-screen-layout.component';
import {CallParticipant, CallParticipantMenuData, CallScreenShare} from '../../../../shared/call/call.types';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-voice-channel',
    imports: [
        NgClass,
        VoiceChannelLobbyComponent,
        CallContextMenuComponent,
        CallParticipantTileComponent,
        CallControlsBarComponent,
        CallScreenLayoutComponent,
        TranslateModule,
    ],
    templateUrl: './voice-channel.component.html',
    host: {
        class: 'flex flex-col h-full overflow-hidden'
    }
})
export class VoiceChannelComponent {
    channel = input.required<ChannelDto>();

    protected voiceSvc = inject(VoiceChannelService);
    protected navService = inject(NavigationService);
    protected rustMedia = inject(RustMediaService);
    protected participants = computed(() =>
        this.voiceSvc.channelParticipants().get(this.channel().id) ?? [],
    );
    protected callParticipants = computed((): CallParticipant[] => this.participants());

    // ── Permission check ───────────────────────────────────────────────────────
    protected screenSharers = computed(() => {
        const all = this.participants();
        const sharers = all.filter(p => p.isScreenSharing);
        if (this.voiceSvc.localState().isScreenSharing && !sharers.some(p => p.isLocal)) {
            const local = all.find(p => p.isLocal);
            if (local) return [...sharers, {...local, isScreenSharing: true}];
        }
        return sharers;
    });
    protected callScreenShares = computed((): CallScreenShare[] =>
        this.screenSharers().map(p => ({
            shareId: p.cfSessionId ?? p.userId,
            userId: p.userId,
            displayName: p.displayName,
            avatarLabel: p.avatarLabel,
            isLocal: p.isLocal,
            stream: (p.isLocal
                ? this.voiceSvc.localScreenStream()
                : this.voiceSvc.getScreenStream(p.userId)) ?? undefined,
            hasAudio: p.isLocal ? this.voiceSvc.localScreenHasAudio() : true,
            isAudioMuted: p.isLocal
                ? this.voiceSvc.localScreenAudioMuted()
                : this.voiceSvc.isScreenAudioMuted(p.userId),
            renderedFps: p.isLocal ? this.rustMedia.renderedFps() : null,
            inboundFps: p.isLocal ? this.rustMedia.inboundFps() : null,
        }))
    );
    protected isJoined = computed(() =>
        this.voiceSvc.joinedChannelId() === this.channel().id,
    );

    // ── Computed helpers ───────────────────────────────────────────────────────
    protected participantGridClass = computed(() => {
        const n = this.participants().length;
        if (n === 1) return 'grid-cols-1 max-w-[240px]';
        if (n === 2) return 'grid-cols-2 max-w-[480px]';
        if (n <= 4) return 'grid-cols-2 max-w-[480px]';
        if (n <= 6) return 'grid-cols-3 max-w-[720px]';
        if (n <= 12) return 'grid-cols-4 max-w-[960px]';
        return 'grid-cols-6';
    });
    protected participantMenu = signal<CallParticipantMenuData | null>(null);
    private guildSvc = inject(GuildService);
    private guildVoice = inject(GuildVoiceService);
    private ownMember = signal<GuildMemberDto | null>(null);
    protected isSuperadmin = computed(() => {
        const m = this.ownMember();
        if (!m) return false;
        return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
    });

    // ── Context menu ───────────────────────────────────────────────────────────

    constructor() {
        effect(() => {
            const guildId = this.channel().guildId;
            this.guildSvc.getOwnMember(guildId).subscribe({
                next: m => this.ownMember.set(m), error: () => {
                }
            });
        });
    }

    protected onParticipantContextMenu(event: MouseEvent, p: CallParticipant): void {
        if (p.isLocal) return;
        event.preventDefault();
        event.stopPropagation();
        const volume = Math.round(this.voiceSvc.getUserVolume(p.userId) * 100);
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantMenu.set({x: Math.max(0, x), y: Math.max(0, y), participant: p, volume});
    }

    protected onVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, volume: value});
        this.voiceSvc.setUserVolume(menu.participant.userId, value / 100);
    }

    protected async kickParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildSvc.kickMemberByUserId(this.channel().guildId, menu.participant.userId)
        ).catch(() => {
        });
    }

    protected async banParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildSvc.banMemberByUserId(this.channel().guildId, menu.participant.userId)
        ).catch(() => {
        });
    }

    protected async toggleServerDeafen(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        const {userId, isServerDeafened} = menu.participant as VoiceChannelParticipant;
        const newState = !isServerDeafened;
        this.participantMenu.set({...menu, participant: {...menu.participant, isServerDeafened: newState}});
        this.voiceSvc.setServerDeafened(userId, newState);
        await firstValueFrom(
            this.guildVoice.serverDeafen(this.channel().guildId, this.channel().id, userId, newState)
        ).catch(() => {
            this.voiceSvc.setServerDeafened(userId, isServerDeafened ?? false);
        });
    }

    // ── Channel actions ────────────────────────────────────────────────────────

    protected joinChannel(): void {
        const view = this.navService.workspace();
        const guildName = view.type === 'server' ? view.guild.name : '';
        void this.voiceSvc.joinChannel(this.channel(), guildName);
    }

    protected leaveChannel(): void {
        void this.voiceSvc.leaveChannel();
    }

    protected toggleMute(): void {
        this.voiceSvc.toggleMute();
    }

    protected toggleDeafen(): void {
        this.voiceSvc.toggleDeafen();
    }

    protected toggleCamera(): void {
        void this.voiceSvc.toggleCamera();
    }

    protected toggleScreenShare(): void {
        void this.voiceSvc.toggleScreenShare();
    }

    protected toggleLocalScreenAudio(): void {
        this.voiceSvc.toggleLocalScreenAudio();
    }

    protected toggleRemoteScreenAudio(userId: string): void {
        this.voiceSvc.toggleScreenAudioMute(userId);
    }

    protected setCaptureFps(fps: number): void {
        void this.rustMedia.setCaptureFps(fps);
    }

    protected setScreenResolution(res: StreamResolution): void {
        void this.rustMedia.setScreenResolution(res);
    }
}
