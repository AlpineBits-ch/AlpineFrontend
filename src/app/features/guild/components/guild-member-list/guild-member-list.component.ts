import {Component, computed, DestroyRef, inject, input, OnChanges, signal, SimpleChanges, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {GuildDto, RoleDto, RoleType} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../enums/member-type.enum';
import {GuildService} from '../../../../services/guild.service';
import {environment} from '../../../../../environments/environment';
import {TranslateModule} from '@ngx-translate/core';
import {Menu} from 'primeng/menu';
import {MenuItem} from 'primeng/api';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {ToastService} from '../../../../services/toast.service';
import {
    GuildWebsocketService,
    WsMemberBanned,
    WsMemberJoined,
    WsMemberKicked,
    WsMemberLeft,
    WsMemberMuted,
    WsMemberUnmuted,
    WsPresenceChanged,
} from '../../../../services/guild-websocket.service';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';
import {UserNameStyleDirective} from '../../../../directives/user-name-style.directive';
import {UserNameStyleInput} from '../../../../models/profile-font.model';
import {BotInstallDialogService} from '../../../bot-install/bot-install-dialog.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';

export interface MemberRoleGroup {
    role: RoleDto;
    members: GuildMemberDto[];
}

@Component({
    selector: 'app-guild-member-list',
    imports: [TranslateModule, Menu, UserStatusDotComponent, UserNameStyleDirective, NgClass],
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

    avatarUrl(member: GuildMemberDto): string | undefined {
        if (!member.profile) return undefined;
        return `${environment.apiUrl}/api/v1/social/profiles/${member.profile.id}/avatar`;
    }

    isBot(member: GuildMemberDto): boolean {
        return member.type === MemberType.Bot;
    }

    effectiveStatus(member: GuildMemberDto): OnlineStatus {
        return this.isBot(member) ? OnlineStatus.Online : member.status;
    }

    // Role color is only used as a fallback -a member's own profile accent color (Nitro-style
    // personalization) always wins when set, matching UserNameStyleDirective's precedence.
    nameStyleFor(member: GuildMemberDto): UserNameStyleInput {
        return {
            accentColor: member.profile?.accentColor ?? this.highestRole(member)?.color,
            font: member.profile?.font,
        };
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
        const perms = own ? parsePermissions(own.roleMembers.reduce((c, m) => m.role.permissions ? (c === '' ? m.role.permissions : `${c},${m.role.permissions}`) : c, own.permissions ?? '')) : 0n;
        const items: MenuItem[] = [];
        const canAct = this.canModerate(member);

        if (canAct && hasPermission(perms, Permissions.KickMembers)) {
            items.push({label: 'Kick', icon: 'pi pi-user-minus', command: () => this.kick(member)});
        }
        if (canAct && hasPermission(perms, Permissions.ModerateMembers)) {
            items.push({label: 'Timeout for 10 minutes', icon: 'pi pi-clock', command: () => this.mute(member, 10)});
        }
        if (canAct && hasPermission(perms, Permissions.BanMembers)) {
            items.push({label: 'Ban', icon: 'pi pi-ban', styleClass: 'text-rose-400', command: () => this.ban(member)});
        }
        if (items.length === 0) {
            items.push({label: 'No actions available', disabled: true});
        }
        return items;
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
