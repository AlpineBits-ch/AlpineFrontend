import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NgClass} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {debounceTime, Subject} from 'rxjs';
import {
    ChannelPermission,
    ChannelType,
    GuildDto,
    RoleDto,
    RoleType,
} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../dtos/response/profile.dto';
import {GuildService, OverridePermissionsDto} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {EffectivePermissionsDto} from '../../../../dtos/response/effective-permissions.dto';
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
import {PermissionPreset, presetsFor} from '../permission-presets';

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

    /**
     * The scope's complete overwrite set after a save or delete, safe for a host to store as-is.
     * Built from the scope's own set with the one target patched in or out, never from the rows:
     * member rows cover one loaded page at most, and roles are only rebuilt from the same set.
     */
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
    /** One per tab: a role's trace must never be read as a member's, and both tabs stay selected. */
    protected readonly selectedRoleId = signal<string | null>(null);
    protected readonly selectedMemberId = signal<string | null>(null);
    private readonly traces = signal<Record<string, EffectivePermissionsDto>>({});
    /** Every overwrite this scope has, including targets no row on screen covers. */
    private readonly liveOverrides = signal<ChannelPermission[]>([]);

    private gateway = inject(PermissionScopeGateway);
    private guildService = inject(GuildService);
    private profiles = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private memberSkip = 0;
    private memberQuerySubject = new Subject<string>();

    /**
     * The scope's identity and overwrites, but only changed (by `Object.is`) when either actually
     * differs. `scope()` is a fresh object on every parent render, so keying reconciliation on it
     * directly would re-run on every patch; this re-runs only when a save, a resync or the private
     * toggle actually changed what a row should show.
     */
    private readonly reconcileOn = computed(
        () => ({id: this.scope().id, overrides: this.scope().overrides}),
        {
            equal: (a, b) =>
                a.id === b.id &&
                PermissionOverridesComponent.overridesFingerprint(a.overrides) ===
                    PermissionOverridesComponent.overridesFingerprint(b.overrides),
        },
    );

    constructor() {
        this.memberQuerySubject
            .pipe(debounceTime(MEMBER_SEARCH_DEBOUNCE_MS), takeUntilDestroyed())
            .subscribe(term => this.searchMembers(term));

        // Reconciles, never rebuilds: a dirty row is a pending edit the user has not saved yet, and
        // the incoming overwrites must not clobber it. `.update()` reads the current rows without
        // tracking them, so this never depends on what it writes.
        effect(() => {
            const {overrides} = this.reconcileOn();
            this.liveOverrides.set(overrides);
            this.reconcileRoleRows(overrides);
            this.reconcileMemberRows(overrides);
        });
    }

    protected get memberPageSize(): number {
        return PermissionOverridesComponent.MEMBER_PAGE_SIZE;
    }

    protected get emptyOverride(): PermOverride {
        return EMPTY_OVERRIDE;
    }

    protected presetsFor(channelType: ChannelType | null): readonly PermissionPreset[] {
        return presetsFor(channelType);
    }

    protected readonly introKey = computed(() =>
        this.scope().kind === 'category' ? 'PERM_OVERRIDE.INTRO_CATEGORY' : 'PERM_OVERRIDE.INTRO',
    );

    protected readonly selectedTrace = computed(() => {
        const id = this.activeTab() === 'roles' ? this.selectedRoleId() : this.selectedMemberId();
        return id ? (this.traces()[id] ?? null) : null;
    });

    protected readonly savedOverrides = computed<Record<string, PermOverride>>(() => {
        const map: Record<string, PermOverride> = {};
        for (const row of this.roleRows()) map[row.subject.id] = this.toOverride(row.perm);
        for (const row of this.memberRows()) map[row.subject.id] = this.toOverride(row.perm);
        return map;
    });

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
        this.liveOverrides.set(this.scope().overrides);
        this.reconcileRoleRows(this.scope().overrides);
    }

    switchTab(tab: 'roles' | 'members'): void {
        this.activeTab.set(tab);
        if (tab === 'members' && this.memberRows().length === 0) this.loadMembers();
    }

    searchRoles(term: string): void {
        this.roleSearch.set(term);
    }

    onRoleSelectionChange(subjectId: string): void {
        this.selectedRoleId.set(subjectId);
        this.loadTrace(subjectId, 'role');
    }

    onMemberSelectionChange(subjectId: string): void {
        this.selectedMemberId.set(subjectId);
        this.loadTrace(subjectId, 'member');
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

        const target = {kind: 'role', id: roleId} satisfies OverrideTarget;
        this.setRoleSaving(roleId, true);
        this.gateway
            .upsert(this.scope(), target, this.body(row.override, this.toOverride(row.perm)))
            .subscribe({
                next: perm => {
                    // The response is the resolved row, which is not always what was sent: re-derive
                    // the editor from it rather than showing the intent as if it had landed.
                    this.roleRows.update(list =>
                        list.map(r =>
                            r.subject.id === roleId
                                ? {
                                      ...r,
                                      perm,
                                      override: this.toOverride(perm),
                                      dirty: false,
                                      saving: false,
                                  }
                                : r,
                        ),
                    );
                    this.forgetTrace(roleId);
                    this.emitUpsert(target, perm);
                },
                error: err => {
                    this.setRoleSaving(roleId, false);
                    this.reportError('PERM_OVERRIDE.SAVE_ERROR', err);
                },
            });
    }

    deleteRole(roleId: string): void {
        const row = this.roleRows().find(r => r.subject.id === roleId);
        if (!row?.perm) return;

        const target = {kind: 'role', id: roleId} satisfies OverrideTarget;
        this.gateway.remove(this.scope(), target).subscribe({
            next: () => {
                this.roleRows.update(list =>
                    list.map(r =>
                        r.subject.id === roleId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
                );
                this.forgetTrace(roleId);
                this.emitRemoval(target);
            },
            error: err => this.reportError('PERM_OVERRIDE.DELETE_ERROR', err),
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

        const target = {kind: 'member', id: memberId} satisfies OverrideTarget;
        this.setMemberSaving(memberId, true);
        this.gateway
            .upsert(this.scope(), target, this.body(row.override, this.toOverride(row.perm)))
            .subscribe({
                next: perm => {
                    this.memberRows.update(list =>
                        list.map(r =>
                            r.subject.id === memberId
                                ? {
                                      ...r,
                                      perm,
                                      override: this.toOverride(perm),
                                      dirty: false,
                                      saving: false,
                                  }
                                : r,
                        ),
                    );
                    this.forgetTrace(memberId);
                    this.emitUpsert(target, perm);
                },
                error: err => {
                    this.setMemberSaving(memberId, false);
                    this.reportError('PERM_OVERRIDE.SAVE_ERROR', err);
                },
            });
    }

    deleteMember(memberId: string): void {
        const row = this.memberRows().find(r => r.subject.id === memberId);
        if (!row?.perm) return;

        const target = {kind: 'member', id: memberId} satisfies OverrideTarget;
        this.gateway.remove(this.scope(), target).subscribe({
            next: () => {
                this.memberRows.update(list =>
                    list.map(r =>
                        r.subject.id === memberId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
                );
                this.forgetTrace(memberId);
                this.emitRemoval(target);
            },
            error: err => this.reportError('PERM_OVERRIDE.DELETE_ERROR', err),
        });
    }

    // Omitting the module pair means "carry over" server-side, so clearing one has to send it
    // explicitly. `saved` is what the server last stored for this subject.
    private body(override: PermOverride, saved: PermOverride): OverridePermissionsDto {
        const dto: OverridePermissionsDto = {
            allowPermissions: stringifyPermissions(override.allow),
            denyPermissions: stringifyPermissions(override.deny),
        };

        const edited = override.allowModule !== saved.allowModule || override.denyModule !== saved.denyModule;

        if (override.allowModule !== 0n || override.denyModule !== 0n || edited) {
            dto.allowModulePermissions = stringifyModulePermissions(override.allowModule);
            dto.denyModulePermissions = stringifyModulePermissions(override.denyModule);
        }

        return dto;
    }

    private emitUpsert(target: OverrideTarget, perm: ChannelPermission): void {
        this.emitOverrides([...this.withoutTarget(target), perm]);
    }

    private emitRemoval(target: OverrideTarget): void {
        this.emitOverrides(this.withoutTarget(target));
    }

    private withoutTarget(target: OverrideTarget): ChannelPermission[] {
        return this.liveOverrides().filter(p =>
            target.kind === 'role' ? p.roleId !== target.id : p.memberId !== target.id,
        );
    }

    private emitOverrides(next: ChannelPermission[]): void {
        this.liveOverrides.set(next);
        this.overridesChanged.emit(next);
    }

    private reportError(key: string, err: unknown): void {
        this.toastService.httpError(this.translate.instant(key), err);
    }

    private setRoleSaving(roleId: string, saving: boolean): void {
        this.roleRows.update(list => list.map(r => (r.subject.id === roleId ? {...r, saving} : r)));
    }

    private setMemberSaving(memberId: string, saving: boolean): void {
        this.memberRows.update(list => list.map(r => (r.subject.id === memberId ? {...r, saving} : r)));
    }

    /** Reads the saved state, so a save has to drop the entry rather than patch it. */
    private loadTrace(subjectId: string, kind: 'role' | 'member'): void {
        const scope = this.scope();
        if (scope.kind !== 'channel' || this.traces()[subjectId]) return;

        this.guildService.getEffectivePermissions(scope.id, {kind, id: subjectId}).subscribe({
            next: dto => this.traces.update(map => ({...map, [subjectId]: dto})),
            error: () => undefined,
        });
    }

    private forgetTrace(subjectId: string): void {
        this.traces.update(map => {
            const next = {...map};
            delete next[subjectId];
            return next;
        });
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

    /** A row's dirty edit survives; a clean row picks up whatever this scope now says. */
    private reconcileRoleRows(overrides: ChannelPermission[]): void {
        this.roleRows.update(current => {
            const byId = new Map(current.map(r => [r.subject.id, r]));
            return this.guild().roles.map(subject => {
                const existing = byId.get(subject.id);
                if (existing?.dirty) return existing;
                const perm = overrides.find(p => p.roleId === subject.id) ?? null;
                return {
                    subject,
                    perm,
                    override: this.toOverride(perm),
                    dirty: false,
                    saving: existing?.saving ?? false,
                };
            });
        });
    }

    /** Only reconciles rows already fetched; never fetches to have something to reconcile. */
    private reconcileMemberRows(overrides: ChannelPermission[]): void {
        this.memberRows.update(current => {
            if (current.length === 0) return current;
            return current.map(row => {
                if (row.dirty) return row;
                const perm = overrides.find(p => p.memberId === row.subject.id) ?? null;
                return {...row, perm, override: this.toOverride(perm)};
            });
        });
    }

    private static overridesFingerprint(overrides: ChannelPermission[]): string {
        return overrides
            .map(
                o =>
                    `${o.roleId ?? o.memberId}:${o.allowPermissions}:${o.denyPermissions}:` +
                    `${o.allowModulePermissions ?? ''}:${o.denyModulePermissions ?? ''}`,
            )
            .sort()
            .join(',');
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
