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
    guild = input.required<GuildDto>();
    rows = signal<GuildMemberDto[]>([]);
    loading = signal(true);
    loadingMore = signal(false);
    hasMore = signal(true);
    protected profileDialogSvc = inject(ProfileDialogService);
    // Members are grouped by their highest-position role (Discord-style hierarchy display).
    // Members with no roles at all fall back to the plain online/offline split.
    roleGroups = computed((): MemberRoleGroup[] => {
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
    onlineRows = computed(() => this.rows().filter(m => !this.hasRole(m) && this.isActive(m)));
    offlineRows = computed(() => this.rows().filter(m => !this.hasRole(m) && !this.isActive(m)));
    @ViewChild('memberMenu') memberMenu!: Menu;
    protected contextMember = signal<GuildMemberDto | null>(null);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
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
    // Deliberately not `environment.apiUrl`: that constant is the venta.gg address baked in at
    // build time, so building an avatar URL from it sent every self-hosted and federated
    // deployment to our servers for an image its own instance was already serving. This signal is
    // the server the active account is really on.
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
        // A household's only removal event - there is no kick to fire guild.MemberKicked instead.
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
        // Roles or nickname changed. Both are rendered here and one of them regroups the whole
        // list, and the payload carries neither the new roles nor the member row - so the page is
        // re-read rather than patched. Scoped to a member already on screen (or ourselves, whose
        // own row decides which entries the context menu offers): a rename in a 5000-member guild
        // must not refetch a list nobody is looking at that part of.
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
        // Stopgap so open member lists refresh after a bot install specifically -
        // guild.MemberJoined (subscribed above) isn't confirmed to also fire for bot
        // installs, so this stays until that's verified. See BotInstallDialogService.
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

    /**
     * Undefined for a member with no avatar, which shows the initial instead.
     *
     * <p>Having a profile is not having an avatar - this URL is built from the profile id and
     * resolves only for members who uploaded one - so the miss is only known once the request
     * fails, and {@link BrokenImageService} is what remembers it.</p>
     */
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

    /**
     * The member's game line, or null.
     *
     * <p>Read from {@link UserActivityService} rather than from the row, because the row is a
     * snapshot from the last page fetch while the store is kept current by `guild.PresenceChanged`.
     * The rows are seeded into the store on fetch, so the two never disagree about a member that
     * has not changed.</p>
     */
    activityFor(member: GuildMemberDto): Activity | null {
        return this.userActivity.primaryFor(member.userId);
    }

    /**
     * Whether this member is currently streaming in one of *this* guild's channels.
     *
     * <p>Deliberately not `GuildVoiceActivityService.isStreaming`, which answers for every guild
     * the service tracks - a member of two guilds this account shares would then show as live here
     * while actually streaming in the other one. `streamingChannelId`, scoped to this guild, is
     * what keeps the badge honest.</p>
     */
    protected isStreaming(member: GuildMemberDto): boolean {
        return this.guildVoiceActivity.streamingChannelId(this.guild().id, member.userId) !== undefined;
    }

    /**
     * Opens the channel a streaming member is live in, joins voice, and arms a watch request for
     * their stream - the same join-and-watch pattern the channel list's own LIVE badge uses.
     *
     * <p>`stopPropagation` because the badge sits inside a row whose own click opens the profile
     * dialog - the two actions must not both fire from one press.</p>
     */
    protected async watchStream(member: GuildMemberDto, event: MouseEvent): Promise<void> {
        event.stopPropagation();

        const guildId = this.guild().id;
        const channelId = this.guildVoiceActivity.streamingChannelId(guildId, member.userId);
        const channel = channelId ? this.guild().channels.find(c => c.id === channelId) : undefined;
        if (!channel) return;

        this.navService.openChannel(channel);
        if (this.voiceChannelSvc.joinedChannelId() !== channel.id) {
            // A refused join has already said so, and focusing a stream in a room we are not in
            // would leave the stage waiting on a participant that never arrives.
            if (!await this.voiceChannelSvc.joinChannel(channel, this.guild().name)) return;
        }
        this.callFocus.request(
            scopeKey({kind: 'channel', guildId, channelId: channel.id}),
            {userId: member.userId},
        );
    }

    // Role color is only used as a fallback -a member's own profile accent color (Nitro-style
    // personalization) always wins when set, matching UserNameStyleDirective's precedence.
    nameStyleFor(member: GuildMemberDto): UserNameStyleInput {
        return {
            accentColor: member.profile?.accentColor ?? this.highestRole(member)?.color,
            font: member.profile?.font,
        };
    }

    /**
     * A member of a household who does not hold Flatmates: a guest.
     *
     * <p>Worth marking rather than leaving to a role chip. Flatmates membership is what puts
     * somebody on the chore rota and hands them the manage bits, so "does Ben live here or is Ben
     * staying the week" is a question this list should answer without anybody opening role
     * settings - and the guest is the row that needs saying, because the flatmates already group
     * under their own heading.</p>
     *
     * <p>Only ever drawn where a Flatmates role actually exists. A household that renamed or
     * deleted it would otherwise have every single member labelled a guest.</p>
     */
    protected isHouseGuest(member: GuildMemberDto): boolean {
        return this.guild().kind === GuildKind.Household
            && !!findFlatmatesRole(this.guild())
            && !isFlatmate(this.guild(), member)
            && !this.isBot(member);
    }

    protected isActive(member: GuildMemberDto): boolean {
        return this.isBot(member) || (member.status !== OnlineStatus.Offline && member.status !== OnlineStatus.Hidden);
    }

    // The @everyone role is assigned to every member and carries no meaningful color/grouping
    // information (it's usually left black) -exclude it so those members fall back to the plain
    // online/offline split instead of forming a giant, unstyled "everyone" role group.
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

                // Hydrates presence for the page just loaded. Scrolling a large roster is the only
                // way most members' activity is ever learned - `guild.PresenceChanged` announces
                // changes, not current state, so a member who started a game before this list was
                // opened is only known from the fetch.
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

    /**
     * Whether this member can be moved out.
     *
     * <p>Gated on the guild being a household rather than on the Moderation module being off: the
     * endpoint is a household one, and a Community guild that happened to have Moderation disabled
     * would only earn a `403` from it.</p>
     */
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
        // Kick, timeout and ban all live behind the Moderation module. With it off the
        // server refuses them for everyone - the owner included - so offering them here
        // would only produce 403s. Note this is a product state, not a permission level.
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
        // Households reach this and Community guilds do not, which is the whole point: with
        // Moderation off none of the three entries above are offered, and without this one the
        // member list would have no way to remove anybody at all. Owner is excluded by
        // `canModerate` - the server refuses it too and asks for a transfer of ownership first.
        if (this.canMoveOut(member) && (hasPermission(perms, Permissions.ManageGuild) || this.isOwner())) {
            items.push({
                label: this.translate.instant('MOVE_OUT.ACTION'),
                icon: 'pi pi-sign-out',
                command: () => this.openMoveOut(member),
            });
        }
        // Available to everyone, including members with no moderation powers at all - which is
        // the point: reporting is what you have when you cannot act yourself. Reporting your own
        // account is a `self_report` refusal, so it is left off your own row.
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
    //
    // A household has no kick: its preset leaves the Moderation module off, which strips
    // KickMembers and BanMembers for everybody including the owner. This is the removal path, and
    // it is deliberately not shaped like one - the dialog below is about unwinding the rota and
    // the money, and the destructive-looking half of it is a decision the house has to make out
    // loud.

    /** The member the move-out dialog is about, or null when it is closed. */
    protected movingOut = signal<GuildMemberDto | null>(null);
    /** Set only after a `409`: what they still owe, and the reason the first attempt was refused. */
    protected moveOutOutstanding = signal<MoveOutOutstanding[]>([]);
    protected moveOutBusy = signal(false);

    protected moveOutName = computed(() => {
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

    /**
     * Runs the move-out.
     *
     * <p>Called twice in the worst case and that is the design: the first attempt sends no
     * write-off, and a `409` is not surfaced as a failure but as the outstanding list plus a second
     * button. Only that second press sends `writeOffBalances`, so nothing can write a debt off
     * without somebody having read what it was.</p>
     */
    protected confirmMoveOut(writeOffBalances = false): void {
        const member = this.movingOut();
        if (!member || this.moveOutBusy()) return;

        this.moveOutBusy.set(true);
        this.guildService.moveOutMember(this.guild().id, member.userId, writeOffBalances).subscribe({
            next: summary => {
                this.moveOutBusy.set(false);
                this.movingOut.set(null);
                this.moveOutOutstanding.set([]);
                // The realtime event removes the row too; doing it here as well means the list does
                // not sit on a member who is gone if the socket is down.
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

    /**
     * Says what the move-out actually did.
     *
     * <p>Chores it paused or dropped are called out rather than counted into a total: a paused
     * chore is one that named this person as its fixed assignee and is now waiting for the house to
     * pick it up, which is exactly the thing that gets forgotten.</p>
     */
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
