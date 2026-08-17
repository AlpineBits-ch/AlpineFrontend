import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {MemberType} from '../../../../../../enums/member-type.enum';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {BrokenImageService} from '../../../../../../services/broken-image.service';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {
    parsePermissionCarrier,
    Permissions,
    stringifyPermissionCarrier,
} from '../../../../../../enums/permissions.enum';
import {EMPTY_CARRIER, FlagCarrier} from '../../../../../../enums/flag-mask';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';
import {guildFeatures} from '../../../../guild-features';
import {PrimeTemplate} from 'primeng/api';
import {ToastService} from '../../../../../../services/toast.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';

/** Just the bits a chip needs: the roles array on the guild is a per-user membership row. */
interface MemberRole {
    name: string;
    color: string;
}

interface MemberRow {
    member: GuildMemberDto;
    profile: ProfileDto | null;
    roles: MemberRole[];
}

@Component({
    selector: 'app-members-settings',
    imports: [
        FormsModule,
        Button,
        InputText,
        Dialog,
        Tooltip,
        PermissionToggleComponent,
        PrimeTemplate,
        TranslateModule,
        UserNameStyleDirective,
    ],
    templateUrl: './members-settings.component.html',
})
export class MembersSettingsComponent implements OnInit {
    readonly guild = input.required<GuildDto>();
    readonly members = signal<MemberRow[]>([]);
    readonly loading = signal(true);
    readonly loadingMore = signal(false);
    readonly hasMore = signal(true);
    readonly filter = signal('');
    readonly editMember = signal<MemberRow | null>(null);
    readonly showEditDialog = signal(false);
    /** A carrier so a member's unrecognised bits survive an edit to the ones we can name. */
    readonly editPerms = signal<FlagCarrier>(EMPTY_CARRIER);
    readonly editPermMask = computed(() => this.editPerms().value);
    readonly editSaving = signal(false);
    readonly confirmKickMember = signal<MemberRow | null>(null);
    readonly showKickDialog = signal(false);
    readonly kicking = signal(false);
    readonly confirmBanMember = signal<MemberRow | null>(null);
    readonly showBanDialog = signal(false);
    readonly banReason = signal('');
    readonly banning = signal(false);
    /** True while the list is showing server-side search hits rather than the paged roster. */
    readonly isSearching = signal(false);
    readonly searchPending = signal(false);
    protected readonly Permissions = Permissions;
    /** Module set for this guild: permission groups whose module is off aren't offered. */
    protected readonly features = computed(() => guildFeatures(this.guild()));
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private brokenImages = inject(BrokenImageService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private readonly TAKE = 50;
    /** Beyond this a row's roles are summarised as "+n": a long list pushed the actions off-row. */
    private readonly MAX_ROLE_CHIPS = 3;
    private nextSkip = 0;
    private searchTimer?: ReturnType<typeof setTimeout>;

    ngOnInit(): void {
        this.load();
    }

    /** Filtering client-side only ever saw the pages already fetched, so a real member on page three came back as "no members"; the guild search endpoint covers the whole roster and is what the role add-member dialog already uses. */
    onFilterChange(query: string): void {
        this.filter.set(query);
        clearTimeout(this.searchTimer);
        const trimmed = query.trim();
        if (!trimmed) {
            this.searchPending.set(false);
            this.isSearching.set(false);
            this.load();
            return;
        }
        this.searchPending.set(true);
        this.searchTimer = setTimeout(() => this.runSearch(trimmed), 300);
    }

    load(): void {
        this.loading.set(true);
        this.isSearching.set(false);
        this.nextSkip = 0;
        this.hasMore.set(true);
        this.members.set([]);
        this.fetchPage();
    }

    loadMore(): void {
        if (this.loadingMore() || !this.hasMore() || this.loading() || this.isSearching()) return;
        this.loadingMore.set(true);
        this.fetchPage();
    }

    onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
            this.loadMore();
        }
    }

    openEditPermissions(row: MemberRow): void {
        this.editMember.set(row);
        // `allowPermissions`, not `permissions`: the member row has no single mask, and reading the field that does not exist opened this dialog with every box unticked no matter what the member had been granted, so a save that meant to add one permission removed the rest.
        this.editPerms.set(parsePermissionCarrier(row.member.allowPermissions));
        this.showEditDialog.set(true);
    }

    onPermissionChange(mask: bigint): void {
        this.editPerms.update(carrier => ({...carrier, value: mask}));
    }

    savePermissions(): void {
        const row = this.editMember();
        if (!row || this.editSaving()) return;
        this.editSaving.set(true);
        const perm = stringifyPermissionCarrier(this.editPerms());
        this.guildService.updateMemberPermissions(this.guild().id, row.member.id, perm).subscribe({
            next: masks => {
                // The response is the four masks, not a member row; merged in rather than swapped for, or the row would lose its profile, roles and presence.
                this.members.update(list =>
                    list.map(r =>
                        r.member.id === row.member.id ? {...r, member: {...r.member, ...masks}} : r,
                    ),
                );
                this.editMember.set(null);
                this.showEditDialog.set(false);
                this.editSaving.set(false);
            },
            error: err => {
                this.editSaving.set(false);
                this.toastService.httpError(
                    this.translate.instant('GUILD_SETTINGS.MEMBERS.PERMISSIONS_ERROR'),
                    err,
                );
            },
        });
    }

    kickMember(row: MemberRow): void {
        if (this.kicking()) return;
        this.kicking.set(true);
        this.guildService.kickMember(this.guild().id, row.member.id).subscribe({
            next: () => {
                this.members.update(list => list.filter(r => r.member.id !== row.member.id));
                this.closeKickDialog();
                this.kicking.set(false);
            },
            error: err => {
                this.kicking.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.MEMBERS.KICK_ERROR'), err);
            },
        });
    }

    openKickDialog(row: MemberRow): void {
        this.confirmKickMember.set(row);
        this.showKickDialog.set(true);
    }

    closeKickDialog(): void {
        this.confirmKickMember.set(null);
        this.showKickDialog.set(false);
    }

    openBanDialog(row: MemberRow): void {
        this.confirmBanMember.set(row);
        this.banReason.set('');
        this.showBanDialog.set(true);
    }

    closeBanDialog(): void {
        this.confirmBanMember.set(null);
        this.showBanDialog.set(false);
    }

    /** Bans are addressed by user id, not member id; the row goes away either way, so the list drops it here rather than refetching the page it sat on. */
    banMember(row: MemberRow): void {
        if (this.banning()) return;
        this.banning.set(true);
        const reason = this.banReason().trim();
        this.guildService
            .banMember(this.guild().id, {userId: row.member.userId, reason: reason || undefined})
            .subscribe({
                next: () => {
                    this.members.update(list => list.filter(r => r.member.id !== row.member.id));
                    this.closeBanDialog();
                    this.banning.set(false);
                    this.toastService.success(this.translate.instant('GUILD_SETTINGS.MEMBERS.BAN_SUCCESS'));
                },
                error: err => {
                    this.banning.set(false);
                    this.toastService.httpError(
                        this.translate.instant('GUILD_SETTINGS.MEMBERS.BAN_ERROR'),
                        err,
                    );
                },
            });
    }

    /** Whether kick and ban are worth offering at all; the server refuses both for the owner and for the caller's own membership, so showing them only bought the user an error toast. Leaving is its own control elsewhere; this page is for acting on other people. */
    canModerate(row: MemberRow): boolean {
        const userId = row.member.userId;
        return userId !== this.guild().ownerId && userId !== this.profileService.ownProfile()?.userId;
    }

    /** No profile yet and nothing else to show: the row renders a placeholder, never a raw id. */
    isResolving(row: MemberRow): boolean {
        return !row.profile && !row.member.nickname;
    }

    displayName(row: MemberRow): string {
        if (this.isBot(row)) {
            return row.member.nickname ?? row.profile?.userName ?? this.unknownName();
        }
        return row.profile?.userName ?? row.member.nickname ?? this.unknownName();
    }

    /** The chips that fit on the row; the rest are counted by {@link extraRoleCount}. */
    visibleRoles(row: MemberRow): MemberRole[] {
        return row.roles.slice(0, this.MAX_ROLE_CHIPS);
    }

    extraRoleCount(row: MemberRow): number {
        return Math.max(0, row.roles.length - this.MAX_ROLE_CHIPS);
    }

    /** Tooltip for the "+n" chip, so a long role list is still readable. */
    extraRoleNames(row: MemberRow): string {
        return row.roles
            .slice(this.MAX_ROLE_CHIPS)
            .map(r => r.name)
            .join(', ');
    }

    /** Roles saved without a colour come back empty; fall back to the brand accent. */
    roleColor(role: MemberRole): string {
        return role.color || 'var(--color-brand)';
    }

    // The API sends an avatarUrl for every profile, uploaded or not, so a URL that has already failed is the only signal that this member has no avatar. See BrokenImageService.
    avatarUrl(row: MemberRow): string | undefined {
        const url = row.profile?.avatarUrl;
        return this.brokenImages.isBroken(url) ? undefined : url;
    }

    onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    isBot(row: MemberRow): boolean {
        return row.member.type === MemberType.Bot;
    }

    private unknownName(): string {
        return this.translate.instant('GUILD_SETTINGS.MEMBERS.UNKNOWN_MEMBER');
    }

    /** Deliberately does not touch `loading`: that swaps the whole list for a spinner, and with a 300ms debounce the page blinked on every keystroke. `searchPending` drives an inline indicator instead and the current rows stay put until the hits arrive. */
    private runSearch(query: string): void {
        this.isSearching.set(true);
        this.hasMore.set(false);
        this.guildService.searchMembers(this.guild().id, query).subscribe({
            next: incoming => {
                const rows: MemberRow[] = incoming.map(m => ({
                    member: m,
                    profile: m.profile ?? null,
                    roles: this.rolesFor(m),
                }));
                this.members.set(rows);
                this.loading.set(false);
                this.searchPending.set(false);
                this.resolveProfiles(rows);
            },
            error: err => {
                this.loading.set(false);
                this.searchPending.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.MEMBERS.LOAD_ERROR'), err);
            },
        });
    }

    /** Keyed on member id so a row removed mid-flight can't misdirect an arriving profile. */
    private resolveProfiles(rows: MemberRow[]): void {
        rows.forEach(row => {
            if (row.profile) return;
            this.profileService.fetchByUserId(row.member.userId).subscribe({
                next: p =>
                    this.members.update(list =>
                        list.map(r => (r.member.id === row.member.id ? {...r, profile: p} : r)),
                    ),
            });
        });
    }

    private fetchPage(): void {
        const skip = this.nextSkip;
        this.guildService.getMembers(this.guild().id, skip, this.TAKE).subscribe({
            next: incoming => {
                const rows: MemberRow[] = incoming.map(m => ({
                    member: m,
                    profile: m.profile ?? null,
                    roles: this.rolesFor(m),
                }));

                if (skip === 0) {
                    this.members.set(rows);
                    this.loading.set(false);
                } else {
                    this.members.update(list => [...list, ...rows]);
                    this.loadingMore.set(false);
                }

                this.nextSkip = skip + incoming.length;
                if (incoming.length < this.TAKE) this.hasMore.set(false);

                this.resolveProfiles(rows);
            },
            error: err => {
                this.loading.set(false);
                this.loadingMore.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.MEMBERS.LOAD_ERROR'), err);
            },
        });
    }

    private rolesFor(member: GuildMemberDto): MemberRole[] {
        return this.guild()
            .roles.filter(r => r.userId === member.userId)
            .map(r => ({name: r.name, color: r.color}));
    }
}
