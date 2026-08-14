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
import {parsePermissionCarrier, Permissions, stringifyPermissionCarrier} from '../../../../../../enums/permissions.enum';
import {EMPTY_CARRIER, FlagCarrier} from '../../../../../../enums/flag-mask';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';
import {guildFeatures} from '../../../../guild-features';
import {PrimeTemplate} from "primeng/api";
import {ToastService} from '../../../../../../services/toast.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';

interface MemberRow {
    member: GuildMemberDto;
    profile: ProfileDto | null;
    roleNames: string[];
}

@Component({
    selector: 'app-members-settings',
    imports: [FormsModule, Button, InputText, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate, TranslateModule, UserNameStyleDirective],
    templateUrl: './members-settings.component.html',
})
export class MembersSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    members = signal<MemberRow[]>([]);
    loading = signal(true);
    loadingMore = signal(false);
    hasMore = signal(true);
    filter = signal('');
    editMember = signal<MemberRow | null>(null);
    showEditDialog = signal(false);
    /** A carrier so a member's unrecognised bits survive an edit to the ones we can name. */
    editPerms = signal<FlagCarrier>(EMPTY_CARRIER);
    editPermMask = computed(() => this.editPerms().value);
    editSaving = signal(false);
    confirmKickMember = signal<MemberRow | null>(null);
    showKickDialog = signal(false);
    kicking = signal(false);
    /** True while the list is showing server-side search hits rather than the paged roster. */
    isSearching = signal(false);
    searchPending = signal(false);
    protected readonly Permissions = Permissions;
    /** Module set for this guild: permission groups whose module is off aren't offered. */
    protected features = computed(() => guildFeatures(this.guild()));
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private brokenImages = inject(BrokenImageService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private readonly TAKE = 50;
    private nextSkip = 0;
    private searchTimer?: ReturnType<typeof setTimeout>;

    ngOnInit(): void {
        this.load();
    }

    /**
     * Filtering client-side only ever saw the pages already fetched, so a real member on
     * page three came back as "no members". The guild search endpoint covers the whole
     * roster and is what the role add-member dialog already uses.
     */
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
        this.editPerms.set(parsePermissionCarrier(row.member.permissions));
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
            next: updated => {
                this.members.update(list =>
                    list.map(r => r.member.id === updated.id
                        ? {...r, member: updated}
                        : r
                    )
                );
                this.editMember.set(null);
                this.showEditDialog.set(false);
                this.editSaving.set(false);
            },
            error: err => {
                this.editSaving.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.MEMBERS.PERMISSIONS_ERROR'), err);
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

    displayName(row: MemberRow): string {
        if (this.isBot(row)) {
            return row.member.nickname ?? row.member.userId.slice(0, 8) + '…';
        }
        return row.profile?.userName ?? row.member.userId.slice(0, 8) + '…';
    }

    // The API sends an avatarUrl for every profile, uploaded or not, so a URL that has already
    // failed is the only signal that this member has no avatar. See BrokenImageService.
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

    private runSearch(query: string): void {
        this.isSearching.set(true);
        this.loading.set(true);
        this.hasMore.set(false);
        this.guildService.searchMembers(this.guild().id, query).subscribe({
            next: incoming => {
                const rows: MemberRow[] = incoming.map(m => ({
                    member: m,
                    profile: m.profile ?? null,
                    roleNames: this.roleNamesFor(m),
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
                next: p => this.members.update(list =>
                    list.map(r => r.member.id === row.member.id ? {...r, profile: p} : r)
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
                    roleNames: this.roleNamesFor(m),
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

    private roleNamesFor(member: GuildMemberDto): string[] {
        return this.guild().roles
            .filter(r => r.userId === member.userId)
            .map(r => r.name);
    }
}
