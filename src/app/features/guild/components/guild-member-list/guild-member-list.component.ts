import {Component, computed, DestroyRef, inject, input, OnChanges, signal, SimpleChanges, ViewChild} from '@angular/core';
import {NgClass, NgTemplateOutlet} from '@angular/common';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {GuildDto, GuildKind, RoleDto, RoleType} from '../../../../dtos/response/guild.dto';
import {
    hasUnresolvedChores,
    MoveOutConflict,
    MoveOutOutstanding,
    MoveOutSummary,
} from '../../../../dtos/response/move-out.dto';
import {formatMinor} from '../../../../helpers/money.helper';
import {findFlatmatesRole, isFlatmate} from '../../household-roles';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../enums/member-type.enum';
import {GuildService} from '../../../../services/guild.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Menu} from 'primeng/menu';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {hasPermission, Permissions} from '../../../../enums/permissions.enum';
import {unionMemberPermissions} from '../../guild-permissions';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {ToastService} from '../../../../services/toast.service';
import {
    GuildWebsocketService,
    WsMemberBanned,
    WsMemberJoined,
    WsMemberKicked,
    WsMemberLeft,
    WsMemberMovedOut,
    WsMemberMuted,
    WsMemberUnmuted,
    WsMemberUpdated,
    WsPresenceChanged,
} from '../../../../services/guild-websocket.service';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';
import {UserNameStyleDirective} from '../../../../directives/user-name-style.directive';
import {UserNameStyleInput} from '../../../../models/profile-font.model';
import {BotInstallDialogService} from '../../../bot-install/bot-install-dialog.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {ReportDialogService} from '../../../../services/report-dialog.service';
import {BrokenImageService} from '../../../../services/broken-image.service';
import {HomeStatusBoardComponent} from '../home-status-board/home-status-board.component';
import {ActivityLineComponent} from '../../../../components/activity-line/activity-line.component';
import {UserActivityService} from '../../../../services/user-activity.service';
import {Activity} from '../../../../models/activity.model';
import {GuildVoiceActivityService} from '../../../../services/guild-voice-activity.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {scopeKey} from '../../../../services/share-watch.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {CallLiveBadgeComponent} from '../../../../shared/call/call-live-badge/call-live-badge.component';

export interface MemberRoleGroup {
    role: RoleDto;
    members: GuildMemberDto[];
}

@Component({
    selector: 'app-guild-member-list',
    imports: [TranslateModule, Menu, UserStatusDotComponent, UserNameStyleDirective, NgClass, NgTemplateOutlet, HomeStatusBoardComponent, ActivityLineComponent, Dialog, Button, PrimeTemplate, CallLiveBadgeComponent],
    templateUrl: './guild-member-list.component.html',
})
export class GuildMemberListComponent implements OnChanges {
    readonly guild = input.required<GuildDto>();
    readonly rows = signal<GuildMemberDto[]>([]);
    readonly loading = signal(true);
    readonly loadingMore = signal(false);
    readonly hasMore = signal(true);
    protected profileDialogSvc = inject(ProfileDialogService);
    // Members are grouped by their highest-position role (Discord-style hierarchy display).
    // Members with no roles at all fall back to the plain online/offline split.
    readonly roleGroups = computed((): MemberRoleGroup[] => {
        const groups = new Map<string, MemberRoleGroup>();
        for (const member of this.rows()) {
            const role = this.highestRole(member);
            if (!role) continue;
            const group = groups.get(role.id);
            if (group) group.members.push(member);
            else groups.set(role.id, {role, members: [member]});
        }
        return [...groups.values()]
            .sort((a, b) => b.role.position - a.role.position)
            .map(g => ({...g, members: [...g.members].sort((a, b) => Number(this.isActive(b)) - Number(this.isActive(a)))}));
    });
    readonly onlineRows = computed(() => this.rows().filter(m => !this.hasRole(m) && this.isActive(m)));
    readonly offlineRows = computed(() => this.rows().filter(m => !this.hasRole(m) && !this.isActive(m)));
    @ViewChild('memberMenu') memberMenu!: Menu;
    protected readonly contextMember = signal<GuildMemberDto | null>(null);
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private botInstallDialogService = inject(BotInstallDialogService);
    private toastService = inject(ToastService);
    private brokenImages = inject(BrokenImageService);
    private userActivity = inject(UserActivityService);
    private guildVoiceActivity = inject(GuildVoiceActivityService);
    private voiceChannelSvc = inject(VoiceChannelService);
    private callFocus = inject(CallFocusService);
    private navService = inject(NavigationService);
    // Deliberately not `environment.apiUrl`: that's the venta.gg address baked in at build time, and would send self-hosted/federated deployments to our servers instead of their own.
    private apiConfig = inject(ApiConfigService);
    private reportDialog = inject(ReportDialogService);
    private translate = inject(TranslateService);
    private destroyRef = inject(DestroyRef);
    private readonly TAKE = 50;
    private nextSkip = 0;

    constructor() {
        this.guildWsService.memberBannedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberBanned) => this.removeIfCurrentGuild(e.guildId, e.userId));
        this.guildWsService.memberKickedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberKicked) => this.removeIfCurrentGuild(e.guildId, e.userId));
        this.guildWsService.memberLeftObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberLeft) => this.removeIfCurrentGuild(e.guildId, e.userId));
        // A household's only removal event: there is no kick to fire guild.MemberKicked instead.
        this.guildWsService.memberMovedOutObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberMovedOut) => this.removeIfCurrentGuild(e.guildId, e.userId));
        this.guildWsService.memberMutedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberMuted) => this.notifyOwnMuteState(e.guildId, e.userId, e.mutedUntil));
        this.guildWsService.memberUnmutedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberUnmuted) => this.notifyOwnMuteState(e.guildId, e.userId, null));
        this.guildWsService.presenceChangedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsPresenceChanged) => {
                if (e.guildId !== this.guild().id) return;
                this.rows.update(list => list.map(m => m.userId === e.userId ? {...m, status: e.status} : m));
            });
        this.guildWsService.memberJoinedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberJoined) => {
                if (e.guildId !== this.guild().id) return;
                if (this.nextSkip > this.TAKE) return;
                this.reset();
                this.fetchPage(this.guild().id);
            });
        // Payload carries neither new roles nor the member row, so the page is re-read rather than patched; scoped to a member already on screen (or ourselves) so a rename in a 5000-member guild doesn't refetch a list nobody is looking at.
        this.guildWsService.memberUpdatedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberUpdated) => {
                if (e.guildId !== this.guild().id) return;
                const isOwn = e.userId === this.ownMember()?.userId;
                if (!isOwn && !this.rows().some(m => m.userId === e.userId)) return;
                this.reset();
                this.fetchPage(this.guild().id);
                if (isOwn) {
                    this.guildService.getOwnMember(this.guild().id).subscribe(m => this.ownMember.set(m));
                }
            });
        // Stopgap so open member lists refresh after a bot install specifically: guild.MemberJoined (subscribed above) isn't confirmed to also fire for bot installs, so this stays until that's verified. See BotInstallDialogService.
        this.botInstallDialogService.installedIntoGuild.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(guildId => {
                if (guildId !== this.guild().id) return;
                this.reset();
                this.fetchPage(this.guild().id);
            });
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['guild']) {
            this.reset();
            this.fetchPage(this.guild().id);
            this.guildService.getOwnMember(this.guild().id).subscribe(m => this.ownMember.set(m));
        }
    }

    loadMore(): void {
        if (this.loadingMore() || !this.hasMore() || this.loading()) return;
        this.loadingMore.set(true);
        this.fetchPage(this.guild().id);
    }

    onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
            this.loadMore();
        }
    }

    displayName(member: GuildMemberDto): string {
        if (this.isBot(member)) {
            return member.nickname ?? member.userId.slice(0, 8) + '…';
        }
        return member.profile?.userName ?? member.userId.slice(0, 8) + '…';
    }

    /** Undefined for a member with no avatar, or after a failed load recorded by {@link BrokenImageService}; only known once the request actually fails. */
    avatarUrl(member: GuildMemberDto): string | undefined {
        if (!member.profile) return undefined;
        const url = `${this.apiConfig.baseUrl()}/api/v1/social/profiles/${member.profile.id}/avatar`;
        return this.brokenImages.isBroken(url) ? undefined : url;
    }

    onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    isBot(member: GuildMemberDto): boolean {
        return member.type === MemberType.Bot;
    }

    effectiveStatus(member: GuildMemberDto): OnlineStatus {
        return this.isBot(member) ? OnlineStatus.Online : member.status;
    }

    /** Read from {@link UserActivityService}, not the row: the row is a stale page-fetch snapshot while the store stays current via `guild.PresenceChanged`. */
    activityFor(member: GuildMemberDto): Activity | null {
        return this.userActivity.primaryFor(member.userId);
    }

    /** Deliberately not `GuildVoiceActivityService.isStreaming` (answers for every guild): a member of two shared guilds would show as live here while streaming in the other one. */
    protected isStreaming(member: GuildMemberDto): boolean {
        return this.guildVoiceActivity.streamingChannelId(this.guild().id, member.userId) !== undefined;
    }

    /** `stopPropagation`: the badge sits inside a row whose own click opens the profile dialog, and the two actions must not both fire from one press. */
    protected async watchStream(member: GuildMemberDto, event: MouseEvent): Promise<void> {
        event.stopPropagation();

        const guildId = this.guild().id;
        const channelId = this.guildVoiceActivity.streamingChannelId(guildId, member.userId);
        const channel = channelId ? this.guild().channels.find(c => c.id === channelId) : undefined;
        if (!channel) return;

        this.navService.openChannel(channel);
        if (this.voiceChannelSvc.joinedChannelId() !== channel.id) {
            // A refused join has already said so; focusing a stream in a room we aren't in would leave the stage waiting on a participant that never arrives.
            if (!await this.voiceChannelSvc.joinChannel(channel, this.guild().name)) return;
        }
        this.callFocus.request(
            scopeKey({kind: 'channel', guildId, channelId: channel.id}),
            {userId: member.userId},
        );
    }

    // Role color is only used as a fallback: a member's own profile accent color always wins when set, matching UserNameStyleDirective's precedence.
    nameStyleFor(member: GuildMemberDto): UserNameStyleInput {
        return {
            accentColor: member.profile?.accentColor ?? this.highestRole(member)?.color,
            font: member.profile?.font,
        };
    }

    /** A member of a household without Flatmates: a guest. Only drawn where a Flatmates role actually exists, or a renamed/deleted role would label every member a guest. */
    protected isHouseGuest(member: GuildMemberDto): boolean {
        return this.guild().kind === GuildKind.Household
            && !!findFlatmatesRole(this.guild())
            && !isFlatmate(this.guild(), member)
            && !this.isBot(member);
    }

    protected isActive(member: GuildMemberDto): boolean {
        return this.isBot(member) || (member.status !== OnlineStatus.Offline && member.status !== OnlineStatus.Hidden);
    }

    // The @everyone role carries no meaningful color/grouping (usually left black), so it's excluded here to avoid forming a giant, unstyled "everyone" role group.
    private significantRoleMembers(member: GuildMemberDto): { role: RoleDto }[] {
        return (member.roleMembers ?? []).filter(rm => rm.role.type !== RoleType.Everyone);
    }

    private hasRole(member: GuildMemberDto): boolean {
        return this.significantRoleMembers(member).length > 0;
    }

    private highestRole(member: GuildMemberDto): RoleDto | undefined {
        const roleMembers = this.significantRoleMembers(member);
        if (roleMembers.length === 0) return undefined;
        return roleMembers.reduce((max, cur) => cur.role.position > max.role.position ? cur : max).role;
    }

    private reset(): void {
        this.rows.set([]);
        this.nextSkip = 0;
        this.hasMore.set(true);
        this.loading.set(true);
        this.loadingMore.set(false);
    }

    private fetchPage(guildId: string): void {
        const skip = this.nextSkip;
        this.guildService.getMembers(guildId, skip, this.TAKE).subscribe({
            next: incoming => {
                if (this.guild().id !== guildId) return;

                // Hydrates presence for the page just loaded: `guild.PresenceChanged` only announces changes, not current state, so a member who started an activity before this list opened is only known from the fetch.
                this.userActivity.seedFromMembers(incoming);

                if (skip === 0) {
                    this.rows.set(incoming);
                    this.loading.set(false);
                } else {
                    this.rows.update(list => [...list, ...incoming]);
                    this.loadingMore.set(false);
                }

                this.nextSkip = skip + incoming.length;
                if (incoming.length < this.TAKE) this.hasMore.set(false);
            },
            error: () => {
                this.loading.set(false);
                this.loadingMore.set(false);
            },
        });
    }

    /** Gated on the guild being a household, not on Moderation being off: the endpoint is household-only, so a Community guild with Moderation disabled would just get a 403. */
    protected canMoveOut(member: GuildMemberDto): boolean {
        return this.guild().kind === GuildKind.Household && this.canModerate(member);
    }

    private isOwner(): boolean {
        return !!this.ownMember() && this.ownMember()!.userId === this.guild().ownerId;
    }

    protected canModerate(member: GuildMemberDto): boolean {
        if (member.userId === this.guild().ownerId) return false;
        const own = this.ownMember();
        if (!own || own.userId === member.userId) return false;
        return true;
    }

    protected onMemberContextMenu(event: MouseEvent, member: GuildMemberDto): void {
        event.preventDefault();
        this.contextMember.set(member);
        this.memberMenu.model = this.buildMemberMenuItems(member);
        this.memberMenu.show(event);
    }

    private buildMemberMenuItems(member: GuildMemberDto): MenuItem[] {
        const own = this.ownMember();
        const perms = unionMemberPermissions(own);
        const items: MenuItem[] = [];
        // Kick, timeout and ban live behind the Moderation module; with it off the server refuses them for everyone (owner included), so offering them here would only produce 403s.
        const canAct = this.canModerate(member) && guildHasFeature(this.guild(), GuildFeature.Moderation);

        if (canAct && hasPermission(perms, Permissions.KickMembers)) {
            items.push({label: 'Kick', icon: 'pi pi-user-minus', command: () => this.kick(member)});
        }
        if (canAct && hasPermission(perms, Permissions.ModerateMembers)) {
            items.push({label: 'Timeout for 10 minutes', icon: 'pi pi-clock', command: () => this.mute(member, 10)});
        }
        if (canAct && hasPermission(perms, Permissions.BanMembers)) {
            items.push({label: 'Ban', icon: 'pi pi-ban', styleClass: 'text-rose-400', command: () => this.ban(member)});
        }
        // Households reach this while Community guilds do not: with Moderation off, this is the only removal option offered. Owner is excluded by `canModerate`; the server refuses that too and asks for an ownership transfer first.
        if (this.canMoveOut(member) && (hasPermission(perms, Permissions.ManageGuild) || this.isOwner())) {
            items.push({
                label: this.translate.instant('MOVE_OUT.ACTION'),
                icon: 'pi pi-sign-out',
                command: () => this.openMoveOut(member),
            });
        }
        // Available to everyone, including members with no moderation powers, since reporting is what you have when you cannot act yourself; left off your own row because that's a `self_report` refusal.
        if (member.userId !== own?.userId) {
            if (items.length > 0) items.push({separator: true});
            items.push({
                label: this.translate.instant('REPORT.TITLE_MEMBER'),
                icon: 'pi pi-flag',
                command: () => this.report(member),
            });
        }
        if (items.length === 0) {
            items.push({label: 'No actions available', disabled: true});
        }
        return items;
    }

    private report(member: GuildMemberDto): void {
        this.reportDialog.open({
            kind: 'User',
            targetUserId: member.userId,
            targetName: member.nickname || member.profile?.userName,
        });
    }

    // ── Moving out ───────────────────────────────────────────────────────────
    // A household has no kick: its Moderation-off preset strips KickMembers and BanMembers for everybody, including the owner, so this is the only removal path.

    /** The member the move-out dialog is about, or null when it is closed. */
    protected readonly movingOut = signal<GuildMemberDto | null>(null);
    /** Set only after a `409`: what they still owe, and the reason the first attempt was refused. */
    protected readonly moveOutOutstanding = signal<MoveOutOutstanding[]>([]);
    protected readonly moveOutBusy = signal(false);

    protected readonly moveOutName = computed(() => {
        const member = this.movingOut();
        return member ? this.displayName(member) : '';
    });

    protected openMoveOut(member: GuildMemberDto): void {
        this.movingOut.set(member);
        this.moveOutOutstanding.set([]);
        this.moveOutBusy.set(false);
    }

    protected cancelMoveOut(): void {
        this.movingOut.set(null);
        this.moveOutOutstanding.set([]);
        this.moveOutBusy.set(false);
    }

    protected outstandingLabel(row: MoveOutOutstanding): string {
        return formatMinor(Math.abs(row.netMinor), row.currency);
    }

    /** True when they owe the house; false when the house owes them. Both block the move-out. */
    protected owesTheHouse(row: MoveOutOutstanding): boolean {
        return row.netMinor < 0;
    }

    /** Called twice in the worst case: the first attempt sends no write-off, and a `409` becomes an outstanding-list prompt rather than a failure. Only a second press sends `writeOffBalances`. */
    protected confirmMoveOut(writeOffBalances = false): void {
        const member = this.movingOut();
        if (!member || this.moveOutBusy()) return;

        this.moveOutBusy.set(true);
        this.guildService.moveOutMember(this.guild().id, member.userId, writeOffBalances).subscribe({
            next: summary => {
                this.moveOutBusy.set(false);
                this.movingOut.set(null);
                this.moveOutOutstanding.set([]);
                // The realtime event removes the row too; doing it here as well means the list doesn't sit on a member who is gone if the socket is down.
                this.rows.update(list => list.filter(m => m.userId !== member.userId));
                this.reportMoveOut(summary);
            },
            error: (err: unknown) => {
                this.moveOutBusy.set(false);
                if (err instanceof HttpErrorResponse && err.status === 409) {
                    // Not an error state. The dialog stays open and grows a second choice.
                    this.moveOutOutstanding.set((err.error as MoveOutConflict)?.outstanding ?? []);
                    return;
                }
                this.toastService.httpError(this.translate.instant('MOVE_OUT.FAILED'), err);
            },
        });
    }

    private reportMoveOut(summary: MoveOutSummary): void {
        this.toastService.success(this.translate.instant('MOVE_OUT.DONE', {name: this.moveOutName()}));
        if (hasUnresolvedChores(summary)) {
            this.toastService.info(this.translate.instant('MOVE_OUT.CHORES_TO_RESOLVE', {
                paused: summary.choresPaused,
                dropped: summary.choresDropped,
            }));
        }
    }

    private kick(member: GuildMemberDto): void {
        this.guildService.kickMember(this.guild().id, member.id).subscribe({
            next: () => this.rows.update(list => list.filter(m => m.id !== member.id)),
            error: err => this.toastService.httpError('Failed to kick member', err),
        });
    }

    private ban(member: GuildMemberDto): void {
        this.guildService.banMember(this.guild().id, {userId: member.userId}).subscribe({
            next: () => this.rows.update(list => list.filter(m => m.id !== member.id)),
            error: err => this.toastService.httpError('Failed to ban member', err),
        });
    }

    private mute(member: GuildMemberDto, minutes: number): void {
        this.guildService.muteMember(this.guild().id, member.id, minutes).subscribe({
            next: () => this.toastService.success(`Muted for ${minutes} minutes`),
            error: err => this.toastService.httpError('Failed to mute member', err),
        });
    }

    private removeIfCurrentGuild(guildId: string, userId: string): void {
        if (guildId !== this.guild().id) return;
        this.rows.update(list => list.filter(m => m.userId !== userId));
    }

    private notifyOwnMuteState(guildId: string, userId: string, mutedUntil: string | null): void {
        if (guildId !== this.guild().id) return;
        const ownUserId = this.ownMember()?.userId;
        if (userId !== ownUserId) return;
        this.toastService.info(mutedUntil ? `You have been muted until ${new Date(mutedUntil).toLocaleTimeString()}` : 'Your timeout has been lifted');
    }
}
