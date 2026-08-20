import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {debounceTime, Subject} from 'rxjs';
import {ChannelPermission, GuildDto, RoleDto, RoleType} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../dtos/response/profile.dto';
import {GuildService, OverridePermissionsDto} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {parsePermissions, stringifyPermissions} from '../../../../enums/permissions.enum';
import {parseModulePermissions, stringifyModulePermissions} from '../../../../enums/module-permissions.enum';
import {
    OverrideEntry,
    PermissionOverridesPanelComponent,
} from '../permission-overrides-panel/permission-overrides-panel.component';
import {
    EMPTY_OVERRIDE,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';
import {OverrideTarget, PermissionScopeGateway} from './permission-scope.gateway';
import {PermissionScope} from './permission-scope';

/** Long enough that a typed word is one request, short enough the results still feel live. */
const MEMBER_SEARCH_DEBOUNCE_MS = 250;

interface Row<T> {
    subject: T;
    perm: ChannelPermission | null;
    override: PermOverride;
    dirty: boolean;
    saving: boolean;
}

type RoleRow = Row<RoleDto>;
type MemberRow = Row<GuildMemberDto> & {profile: ProfileDto | null};

@Component({
    selector: 'app-permission-overrides',
    imports: [NgClass, PermissionOverridesPanelComponent, TranslateModule],
    templateUrl: './permission-overrides.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionOverridesComponent implements OnInit {
    readonly scope = input.required<PermissionScope>();
    readonly guild = input.required<GuildDto>();

    /** The scope's overwrites after a save or delete, so the host can keep its own copy honest. */
    readonly overridesChanged = output<ChannelPermission[]>();

    private static readonly MEMBER_PAGE_SIZE = 50;

    protected readonly activeTab = signal<'roles' | 'members'>('roles');
    protected readonly roleRows = signal<RoleRow[]>([]);
    protected readonly memberRows = signal<MemberRow[]>([]);
    protected readonly membersLoading = signal(false);
    /** Loading a further page, as opposed to the first: the panel stays mounted, only the row spins. */
    protected readonly loadingMoreMembers = signal(false);
    protected readonly memberSearch = signal('');
    protected readonly hasMoreMembers = signal(false);
    protected readonly roleSearch = signal('');

    private gateway = inject(PermissionScopeGateway);
    private guildService = inject(GuildService);
    private profiles = inject(ProfileService);
    private memberSkip = 0;
    private memberQuerySubject = new Subject<string>();

    constructor() {
        this.memberQuerySubject
            .pipe(debounceTime(MEMBER_SEARCH_DEBOUNCE_MS), takeUntilDestroyed())
            .subscribe(term => this.searchMembers(term));
    }

    protected get memberPageSize(): number {
        return PermissionOverridesComponent.MEMBER_PAGE_SIZE;
    }

    protected get emptyOverride(): PermOverride {
        return EMPTY_OVERRIDE;
    }

    protected readonly introKey = computed(() =>
        this.scope().kind === 'category' ? 'PERM_OVERRIDE.INTRO_CATEGORY' : 'PERM_OVERRIDE.INTRO',
    );

    protected readonly roleEntries = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        const rows = this.roleRows();
        const overridden = rows
            .filter(
                r =>
                    (r.perm !== null || r.dirty) &&
                    r.subject.id !== everyoneId &&
                    this.matchesRoleSearch(r.subject),
            )
            .map(r => this.toRoleEntry(r, false));
        const everyone = rows.find(r => r.subject.id === everyoneId);
        return everyone ? [...overridden, this.toRoleEntry(everyone, true)] : overridden;
    });

    protected readonly addableRoles = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        return this.roleRows()
            .filter(
                r =>
                    r.perm === null &&
                    !r.dirty &&
                    r.subject.id !== everyoneId &&
                    this.matchesRoleSearch(r.subject),
            )
            .map(r => this.toRoleEntry(r, false));
    });

    protected readonly memberEntries = computed<OverrideEntry[]>(() =>
        this.memberRows()
            .filter(r => r.perm !== null || r.dirty)
            .map(r => this.toMemberEntry(r)),
    );

    protected readonly addableMembers = computed<OverrideEntry[]>(() =>
        this.memberRows()
            .filter(r => r.perm === null && !r.dirty)
            .map(r => this.toMemberEntry(r)),
    );

    ngOnInit(): void {
        this.buildRoleRows();
    }

    switchTab(tab: 'roles' | 'members'): void {
        this.activeTab.set(tab);
        if (tab === 'members' && this.memberRows().length === 0) this.loadMembers();
    }

    searchRoles(term: string): void {
        this.roleSearch.set(term);
    }

    /** Bound to the search box; debounces before actually searching. */
    onMemberQuery(term: string): void {
        this.memberQuerySubject.next(term);
    }

    searchMembers(term: string): void {
        this.memberSearch.set(term);

        if (term.trim() === '') {
            this.memberSkip = 0;
            this.memberRows.set([]);
            this.loadMemberPage(false);
            return;
        }

        this.membersLoading.set(true);
        this.guildService.searchMembers(this.guild().id, term).subscribe({
            next: members => {
                this.memberRows.set(members.map(m => this.toMemberRow(m)));
                this.hasMoreMembers.set(false);
                this.membersLoading.set(false);
                this.hydrateProfiles();
            },
            error: () => this.membersLoading.set(false),
        });
    }

    loadMoreMembers(): void {
        if (this.loadingMoreMembers() || !this.hasMoreMembers()) return;
        this.loadMemberPage(true);
    }

    onRoleChange(roleId: string, override: PermOverride): void {
        this.roleRows.update(list =>
            list.map(r => (r.subject.id === roleId ? {...r, override, dirty: true} : r)),
        );
    }

    onAddRole(roleId: string): void {
        this.onRoleChange(roleId, EMPTY_OVERRIDE);
    }

    saveRole(roleId: string): void {
        const row = this.roleRows().find(r => r.subject.id === roleId);
        if (!row || row.saving) return;

        this.setRoleSaving(roleId, true);
        this.gateway
            .upsert(
                this.scope(),
                {kind: 'role', id: roleId} satisfies OverrideTarget,
                this.body(row.override),
            )
            .subscribe({
                next: perm => {
                    this.roleRows.update(list =>
                        list.map(r =>
                            r.subject.id === roleId ? {...r, perm, dirty: false, saving: false} : r,
                        ),
                    );
                    this.emitOverrides();
                },
                error: () => this.setRoleSaving(roleId, false),
            });
    }

    deleteRole(roleId: string): void {
        const row = this.roleRows().find(r => r.subject.id === roleId);
        if (!row?.perm) return;

        this.gateway.remove(this.scope(), {kind: 'role', id: roleId} satisfies OverrideTarget).subscribe({
            next: () => {
                this.roleRows.update(list =>
                    list.map(r =>
                        r.subject.id === roleId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
                );
                this.emitOverrides();
            },
        });
    }

    onMemberChange(memberId: string, override: PermOverride): void {
        this.memberRows.update(list =>
            list.map(r => (r.subject.id === memberId ? {...r, override, dirty: true} : r)),
        );
    }

    onAddMember(memberId: string): void {
        this.onMemberChange(memberId, EMPTY_OVERRIDE);
    }

    saveMember(memberId: string): void {
        const row = this.memberRows().find(r => r.subject.id === memberId);
        if (!row || row.saving) return;

        this.setMemberSaving(memberId, true);
        this.gateway
            .upsert(
                this.scope(),
                {kind: 'member', id: memberId} satisfies OverrideTarget,
                this.body(row.override),
            )
            .subscribe({
                next: perm => {
                    this.memberRows.update(list =>
                        list.map(r =>
                            r.subject.id === memberId ? {...r, perm, dirty: false, saving: false} : r,
                        ),
                    );
                    this.emitOverrides();
                },
                error: () => this.setMemberSaving(memberId, false),
            });
    }

    deleteMember(memberId: string): void {
        const row = this.memberRows().find(r => r.subject.id === memberId);
        if (!row?.perm) return;

        this.gateway.remove(this.scope(), {kind: 'member', id: memberId} satisfies OverrideTarget).subscribe({
            next: () => {
                this.memberRows.update(list =>
                    list.map(r =>
                        r.subject.id === memberId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
                );
                this.emitOverrides();
            },
        });
    }

    private body(override: PermOverride): OverridePermissionsDto {
        const dto: OverridePermissionsDto = {
            allowPermissions: stringifyPermissions(override.allow),
            denyPermissions: stringifyPermissions(override.deny),
        };

        if (override.allowModule !== 0n || override.denyModule !== 0n) {
            dto.allowModulePermissions = stringifyModulePermissions(override.allowModule);
            dto.denyModulePermissions = stringifyModulePermissions(override.denyModule);
        }

        return dto;
    }

    private emitOverrides(): void {
        const rows = [...this.roleRows().map(r => r.perm), ...this.memberRows().map(r => r.perm)].filter(
            (p): p is ChannelPermission => p !== null,
        );
        this.overridesChanged.emit(rows);
    }

    private setRoleSaving(roleId: string, saving: boolean): void {
        this.roleRows.update(list => list.map(r => (r.subject.id === roleId ? {...r, saving} : r)));
    }

    private setMemberSaving(memberId: string, saving: boolean): void {
        this.memberRows.update(list => list.map(r => (r.subject.id === memberId ? {...r, saving} : r)));
    }

    private everyoneRoleId(): string | undefined {
        return this.guild().roles.find(r => r.type === RoleType.Everyone)?.id;
    }

    private toOverride(perm: ChannelPermission | null): PermOverride {
        return {
            allow: perm ? parsePermissions(perm.allowPermissions) : 0n,
            deny: perm ? parsePermissions(perm.denyPermissions) : 0n,
            allowModule: parseModulePermissions(perm?.allowModulePermissions),
            denyModule: parseModulePermissions(perm?.denyModulePermissions),
        };
    }

    private toRoleEntry(row: RoleRow, pinned: boolean): OverrideEntry {
        return {
            id: row.subject.id,
            name: row.subject.name,
            color: row.subject.color,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            pinned,
            override: row.override,
        };
    }

    private toMemberEntry(row: MemberRow): OverrideEntry {
        const profile = row.profile ?? this.profiles.getCachedByUserId(row.subject.userId) ?? null;
        return {
            id: row.subject.id,
            name: profile?.userName ?? row.subject.userId.slice(0, 8) + '…',
            avatarUrl: profile?.avatarUrl ?? null,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            override: row.override,
        };
    }

    private buildRoleRows(): void {
        const overrides = this.scope().overrides;
        this.roleRows.set(
            this.guild().roles.map(subject => {
                const perm = overrides.find(p => p.roleId === subject.id) ?? null;
                return {subject, perm, override: this.toOverride(perm), dirty: false, saving: false};
            }),
        );
    }

    private matchesRoleSearch(role: RoleDto): boolean {
        const term = this.roleSearch().trim().toLowerCase();
        return term === '' || role.name.toLowerCase().includes(term);
    }

    private loadMembers(): void {
        this.memberSkip = 0;
        this.loadMemberPage(false);
    }

    private loadMemberPage(append: boolean): void {
        // The initial load blanks the whole panel; an append only spins the "load more" row, so the
        // sidebar and the open editor stay mounted and the user doesn't lose their place.
        const loading = append ? this.loadingMoreMembers : this.membersLoading;
        loading.set(true);
        const size = this.memberPageSize;

        this.guildService.getMembers(this.guild().id, this.memberSkip, size).subscribe({
            next: members => {
                const rows = members.map(m => this.toMemberRow(m));
                this.memberRows.update(list => (append ? [...list, ...rows] : rows));
                this.memberSkip += members.length;
                this.hasMoreMembers.set(members.length === size);
                loading.set(false);
                this.hydrateProfiles();
            },
            error: () => loading.set(false),
        });
    }

    private toMemberRow(subject: GuildMemberDto): MemberRow {
        const perm = this.scope().overrides.find(p => p.memberId === subject.id) ?? null;
        return {
            subject,
            profile: this.profiles.getCachedByUserId(subject.userId) ?? null,
            perm,
            override: this.toOverride(perm),
            dirty: false,
            saving: false,
        };
    }

    // getCachedByUserId, never fetchByUserId: that one bypasses the cache by design, which is what
    // turned this tab into one request per member.
    private hydrateProfiles(): void {
        for (const row of this.memberRows()) {
            if (row.profile) continue;
            this.profiles.resolveByUserId(row.subject.userId);
        }
    }
}
