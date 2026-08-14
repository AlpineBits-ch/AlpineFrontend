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
import {VoiceChannelLobbyComponent} from './voice-channel-lobby.component';
import {CallContextMenuComponent} from '../../../../shared/call/call-context-menu/call-context-menu.component';
import {CallControlsBarComponent} from '../../../../shared/call/call-controls-bar/call-controls-bar.component';
import {AutoHideCallControlsDirective} from '../../../../shared/call/auto-hide-call-controls.directive';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {CallScreenLayoutComponent} from '../../../../shared/call/call-screen-layout/call-screen-layout.component';
import {CallStatusBarComponent} from '../../../../shared/call/call-status-bar/call-status-bar.component';
import {CallParticipant, CallParticipantMenuData, CallScreenShare} from '../../../../shared/call/call.types';
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
    private translate = inject(TranslateService);
    protected participants = computed(() =>
        this.voiceSvc.channelParticipants().get(this.channel().id) ?? [],
    );
    /** See {@link guildCallParticipants} - the mapping is shared with the app-level mini-player. */
    protected callParticipants = computed((): CallParticipant[] =>
        guildCallParticipants(this.voiceSvc, this.participants()),
    );
    protected audio = trackAudioWait(this.callParticipants, this.voiceSvc.participantsWithAudio);

    /** See {@link guildScreenShares} - the mapping is shared with the app-level mini-player. */
    protected callScreenShares = computed((): CallScreenShare[] =>
        guildScreenShares(this.voiceSvc, this.rustMedia, this.participants()),
    );

    /**
     * Whether this client's own share asked for audio and got none.
     *
     * <p>`'unavailable'` is the one outcome that needs saying: `'off'` means nobody asked, and
     * `'published'` needs no comment. The two must not read the same, which is why
     * `RustMediaService.screenAudioOutcome` is three-valued rather than a boolean - see its comment.</p>
     *
     * <p>Only while this client is actually sharing, so a stale outcome from a share that has since
     * ended cannot leave the notice on screen.</p>
     */
    protected screenAudioUnavailable = computed(() =>
        this.voiceSvc.localState().isScreenSharing
        && this.rustMedia.screenAudioOutcome() === 'unavailable',
    );
    protected isJoined = computed(() =>
        this.voiceSvc.joinedChannelId() === this.channel().id,
    );
    /** Null until joined: watching is a claim only a participant of the channel may make. */
    protected watchScope = computed((): WatchScope | null => this.isJoined()
        ? {kind: 'channel', guildId: this.channel().guildId, channelId: this.channel().id}
        : null);

    /**
     * Resolves a viewer count popover's user ids against this channel's own roster - see
     * CallScreenLayoutComponent.nameOf for why the layout takes this as an input rather than
     * reaching for a guild member lookup itself. A viewer of a share in this channel is, by
     * construction, someone `setWatching` could only have been called for while in the channel, so
     * the roster this component already computes for the participant strip is enough; the
     * translated fallback below is only ever seen for a viewer whose join notification has not
     * landed yet, and should be brief in practice - never the raw user id, which is an internal
     * identifier with no business appearing in a user-facing popover.
     */
    protected readonly resolveMemberName = (userId: string): string =>
        this.participants().find(p => p.userId === userId)?.displayName
        ?? this.translate.instant('CALL.UNKNOWN_VIEWER');

    // ── Computed helpers ───────────────────────────────────────────────────────
    protected participantMenu = signal<CallParticipantMenuData | null>(null);
    private guildSvc = inject(GuildService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private guildVoice = inject(GuildVoiceService);
    private callFocus = inject(CallFocusService);
    private presence = inject(CallStagePresenceService);
    private ownMember = signal<GuildMemberDto | null>(null);

    // ── Permission checks ──────────────────────────────────────────────────────
    protected isSuperadmin = computed(() => {
        const m = this.ownMember();
        if (!m) return false;
        return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
    });
    /** Kick and ban belong to the Moderation module, which a guild can have switched off. */
    protected hasModeration = computed(() => {
        const ws = this.navService.workspace();
        return ws.type !== 'server' || guildHasFeature(ws.guild, GuildFeature.Moderation);
    });

    // ── Context menu ───────────────────────────────────────────────────────────

    constructor() {
        // Tells the app-level mini-player that this session's full stage is on screen, so it can
        // stand down - see CallStagePresenceService. Keyed by this channel rather than by "guild
        // voice", so browsing a *different* voice channel while connected leaves the mini-player up
        // for the channel actually being listened to. Registering unconditionally (lobby included)
        // is safe for the same reason: the only way this key matches the one the mini-player asks
        // about is if this is the joined channel, and then this view is the real stage, never a
        // lobby.
        this.presence.track(computed(() => scopeKey({
            kind: 'channel',
            guildId: this.channel().guildId,
            channelId: this.channel().id,
        })));

        effect(() => {
            const guildId = this.channel().guildId;
            // Re-runs when guild.MemberUpdated says our own roles changed - see ownMemberRevision.
            this.ownMemberRevision.revision();
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
        // Left undefined when not sharing - that is what the menu template reads to decide whether
        // the second slider has anything to control.
        const streamVolume = p.isScreenSharing
            ? Math.round(this.voiceSvc.getScreenVolume(p.userId) * 100)
            : undefined;
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantMenu.set({x: Math.max(0, x), y: Math.max(0, y), participant: p, volume, streamVolume});
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
            this.guildSvc.kickMemberByUserId(this.channel().guildId, menu.participant.userId)
        ).catch(() => {
        });
    }

    protected async banParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildSvc.banMember(this.channel().guildId, {userId: menu.participant.userId})
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
        void this.doJoinChannel();
    }

    /**
     * The lobby's "join and watch a specific streamer" action. Joins exactly like the plain join
     * button, then arms a focus request for that user - unlike a LIVE badge click (Task 3, channel
     * list), this is an explicit join affordance, so joining voice here is the right call.
     */
    protected async joinAndWatch(userId: string): Promise<void> {
        await this.doJoinChannel();
        const channel = this.channel();
        this.callFocus.request(
            scopeKey({kind: 'channel', guildId: channel.guildId, channelId: channel.id}),
            {userId},
        );
    }

    private async doJoinChannel(): Promise<void> {
        const view = this.navService.workspace();
        const guildName = view.type === 'server' ? view.guild.name : '';
        await this.voiceSvc.joinChannel(this.channel(), guildName);
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
}
