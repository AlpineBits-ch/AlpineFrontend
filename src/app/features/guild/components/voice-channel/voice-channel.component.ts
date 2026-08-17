import {Component, computed, effect, inject, input, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../services/voice-channel.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {RustMediaService} from '../../../../services/rust-media.service';
import {StreamPreset} from '../../../../models/stream-preset';
import {VIDEO_BLOCK_KEYS} from '../../../../core/voice-limits';
import {EntitlementSubjectDto} from '../../../../dtos/response/entitlement.dto';
import {VoiceLimitNoticeComponent} from '../../../../shared/call/voice-limit-notice/voice-limit-notice.component';
import {SettingsUiService} from '../../../../services/settings-ui.service';
import {VoiceChannelLobbyComponent} from './voice-channel-lobby.component';
import {CallContextMenuComponent} from '../../../../shared/call/call-context-menu/call-context-menu.component';
import {CallControlsBarComponent} from '../../../../shared/call/call-controls-bar/call-controls-bar.component';
import {AutoHideCallControlsDirective} from '../../../../shared/call/auto-hide-call-controls.directive';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {CallScreenLayoutComponent} from '../../../../shared/call/call-screen-layout/call-screen-layout.component';
import {CallStatusBarComponent} from '../../../../shared/call/call-status-bar/call-status-bar.component';
import {VoiceRingPickerComponent} from '../../../../shared/call/voice-ring-picker/voice-ring-picker.component';
import {CallParticipant, CallParticipantMenuData, CallScreenShare} from '../../../../shared/call/call.types';
import type {StreamStatsSnapshot} from '../../../../shared/call/stream-stats';
import {WatchScope, scopeKey} from '../../../../services/share-watch.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {CallStagePresenceService} from '../../../../services/call-stage-presence.service';
import {guildCallParticipants, guildScreenShares} from '../../../../shared/call/call-projection';
import {trackAudioWait} from '../../../../shared/call/audio-wait';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

@Component({
    selector: 'app-voice-channel',
    imports: [
        VoiceChannelLobbyComponent,
        CallContextMenuComponent,
        CallControlsBarComponent,
        CallScreenLayoutComponent,
        CallStatusBarComponent,
        AutoHideCallControlsDirective,
        VoiceLimitNoticeComponent,
        VoiceRingPickerComponent,
        TranslateModule,
    ],
    templateUrl: './voice-channel.component.html',
    host: {
        class: 'flex flex-col h-full overflow-hidden',
    },
})
export class VoiceChannelComponent {
    readonly channel = input.required<ChannelDto>();

    protected voiceSvc = inject(VoiceChannelService);
    protected navService = inject(NavigationService);
    protected rustMedia = inject(RustMediaService);
    private translate = inject(TranslateService);
    protected readonly participants = computed(
        () => this.voiceSvc.channelParticipants().get(this.channel().id) ?? [],
    );
    /** See {@link guildCallParticipants}: the mapping is shared with the app-level mini-player. */
    protected readonly callParticipants = computed((): CallParticipant[] =>
        guildCallParticipants(this.voiceSvc, this.participants()),
    );
    protected audio = trackAudioWait(this.callParticipants, this.voiceSvc.participantsWithAudio);

    /** See {@link guildScreenShares}: the mapping is shared with the app-level mini-player. */
    protected readonly callScreenShares = computed((): CallScreenShare[] =>
        guildScreenShares(this.voiceSvc, this.rustMedia, this.participants()),
    );

    /** True only while this client is actively sharing, so a stale outcome from a finished share cannot leave the notice on screen. */
    protected readonly screenAudioUnavailable = computed(
        () =>
            this.voiceSvc.localState().isScreenSharing &&
            this.rustMedia.screenAudioOutcome() === 'unavailable',
    );
    protected readonly isJoined = computed(() => this.voiceSvc.joinedChannelId() === this.channel().id);

    /** Scoped to this channel: a join running for a different room must not show a spinner on a button nobody pressed. */
    protected readonly isJoining = computed(() => this.voiceSvc.pendingJoinId() === this.channel().id);

    // ── Entitlements ───────────────────────────────────────────────────────────

    protected readonly limitNotices = computed(() => (this.isJoined() ? this.voiceSvc.limits.notices() : []));

    /** Null while the camera is on regardless of room limits, so a live publish is never stranded behind a disabled stop button. */
    protected readonly cameraBlockedKey = computed(() =>
        this.blockKey(this.voiceSvc.localState().isCameraOn),
    );

    protected readonly shareBlockedKey = computed(() =>
        this.blockKey(this.voiceSvc.localState().isScreenSharing),
    );

    protected readonly audioOnly = computed(() => this.isJoined() && this.voiceSvc.limits.audioOnly());

    /** "2 of 2 sharing", or null when nothing counts publishers on this instance. */
    protected readonly publisherSlots = computed(() => this.voiceSvc.limits.publisherSlots());

    /** What the granted rung permits, so the quality picker stops where the plan does. */
    protected readonly videoCeiling = computed(() => this.voiceSvc.limits.videoCeiling());

    /** Null when the room has no participant ceiling, so the header falls back to the bare count. */
    protected readonly participantSlots = computed(() =>
        this.voiceSvc.limits.participantSlots(this.participants().length),
    );

    private blockKey(alreadyPublishing: boolean): string | null {
        const block = this.voiceSvc.videoBlock(alreadyPublishing);
        return block ? VIDEO_BLOCK_KEYS[block] : null;
    }
    /** Null until joined: watching is a claim only a participant of the channel may make. */
    protected readonly watchScope = computed((): WatchScope | null =>
        this.isJoined()
            ? {kind: 'channel', guildId: this.channel().guildId, channelId: this.channel().id}
            : null,
    );

    // ── Ring ────────────────────────────────────────────────────────────────
    protected readonly showRingPicker = signal(false);
    /** Anybody already in the room. A ring at them is a correct no-op, so it is not offered. */
    protected readonly participantUserIds = computed(() => this.participants().map(p => p.userId));

    protected openRingPicker(): void {
        this.showRingPicker.set(true);
    }

    /** Falls back to a translated placeholder, never the raw user id: that's an internal identifier with no business in user-facing UI. */
    protected readonly resolveMemberName = (userId: string): string =>
        this.participants().find(p => p.userId === userId)?.displayName ??
        this.translate.instant('CALL.UNKNOWN_VIEWER');

    /** Keyed by user: the guild `CallScreenShare[]` is one row per participant, so the user identifies the stream here. */
    protected readonly inboundStatsOf = (share: CallScreenShare): StreamStatsSnapshot | null =>
        this.voiceSvc.rtc.inspected()?.userId === share.userId ? this.voiceSvc.rtc.inspectedStats() : null;

    protected onStatsInspect(share: CallScreenShare | null): void {
        this.voiceSvc.rtc.inspected.set(share ? {shareId: share.shareId, userId: share.userId} : null);
    }

    // ── Computed helpers ───────────────────────────────────────────────────────
    protected readonly participantMenu = signal<CallParticipantMenuData | null>(null);
    private guildSvc = inject(GuildService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private guildVoice = inject(GuildVoiceService);
    private callFocus = inject(CallFocusService);
    private presence = inject(CallStagePresenceService);
    private settingsUi = inject(SettingsUiService);
    private readonly ownMember = signal<GuildMemberDto | null>(null);

    // ── Permission checks ──────────────────────────────────────────────────────
    protected readonly isSuperadmin = computed(() => {
        const m = this.ownMember();
        if (!m) return false;
        return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
    });
    /** Kick and ban belong to the Moderation module, which a guild can have switched off. */
    protected readonly hasModeration = computed(() => {
        const ws = this.navService.workspace();
        return ws.type !== 'server' || guildHasFeature(ws.guild, GuildFeature.Moderation);
    });

    // ── Context menu ───────────────────────────────────────────────────────────

    constructor() {
        // Keyed by this channel (not "guild voice") so the mini-player stands down only for the channel actually on screen; see CallStagePresenceService.
        this.presence.track(
            computed(() =>
                scopeKey({
                    kind: 'channel',
                    guildId: this.channel().guildId,
                    channelId: this.channel().id,
                }),
            ),
        );

        effect(() => {
            const guildId = this.channel().guildId;
            // Re-runs when guild.MemberUpdated says our own roles changed; see ownMemberRevision.
            this.ownMemberRevision.revision();
            this.guildSvc.getOwnMember(guildId).subscribe({
                next: m => this.ownMember.set(m),
                error: () => {},
            });
        });
    }

    protected onParticipantContextMenu(event: MouseEvent, p: CallParticipant): void {
        if (p.isLocal) return;
        event.preventDefault();
        event.stopPropagation();
        const volume = Math.round(this.voiceSvc.getUserVolume(p.userId) * 100);
        // Left undefined when not sharing, which the menu template reads to decide whether the second slider appears.
        const streamVolume = p.isScreenSharing
            ? Math.round(this.voiceSvc.getScreenVolume(p.userId) * 100)
            : undefined;
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantMenu.set({
            x: Math.max(0, x),
            y: Math.max(0, y),
            participant: p,
            volume,
            streamVolume,
        });
    }

    protected onVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, volume: value});
        this.voiceSvc.setUserVolume(menu.participant.userId, value / 100);
    }

    protected onStreamVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, streamVolume: value});
        this.voiceSvc.setScreenVolume(menu.participant.userId, value / 100);
    }

    protected async kickParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildSvc.kickMemberByUserId(this.channel().guildId, menu.participant.userId),
        ).catch(() => {});
    }

    protected async banParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildSvc.banMember(this.channel().guildId, {userId: menu.participant.userId}),
        ).catch(() => {});
    }

    protected async toggleServerDeafen(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        const {userId, isServerDeafened} = menu.participant as VoiceChannelParticipant;
        const newState = !isServerDeafened;
        this.participantMenu.set({...menu, participant: {...menu.participant, isServerDeafened: newState}});
        this.voiceSvc.setServerDeafened(userId, newState);
        await firstValueFrom(
            this.guildVoice.serverDeafen(this.channel().guildId, this.channel().id, userId, newState),
        ).catch(() => {
            this.voiceSvc.setServerDeafened(userId, isServerDeafened ?? false);
        });
    }

    // ── Channel actions ────────────────────────────────────────────────────────

    protected joinChannel(): void {
        void this.doJoinChannel();
    }

    protected async joinAndWatch(userId: string): Promise<void> {
        if (!(await this.doJoinChannel())) return;
        const channel = this.channel();
        this.callFocus.request(scopeKey({kind: 'channel', guildId: channel.guildId, channelId: channel.id}), {
            userId,
        });
    }

    private async doJoinChannel(): Promise<boolean> {
        const view = this.navService.workspace();
        const guildName = view.type === 'server' ? view.guild.name : '';
        return this.voiceSvc.joinChannel(this.channel(), guildName);
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

    protected setScreenPreset(preset: StreamPreset): void {
        void this.voiceSvc.setScreenPreset(preset);
    }

    /** Aimed by `subject` (the party the remedy applies to), never by whichever guild is on screen: for a paired ceiling those routinely differ. */
    protected onUpgrade(subject: EntitlementSubjectDto | null): void {
        if (subject?.kind === 'user') {
            this.settingsUi.open('billing');
            return;
        }
        this.settingsUi.openGuild(subject?.id ?? this.channel().guildId, 'plan');
    }
}
