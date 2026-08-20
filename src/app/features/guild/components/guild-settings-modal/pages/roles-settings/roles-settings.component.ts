import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto, RoleMemberDto} from '../../../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {CreateRoleDto, GuildService, UpdateRoleDto} from '../../../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../../../services/guild-websocket.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {BrokenImageService} from '../../../../../../services/broken-image.service';
import {ToastService} from '../../../../../../services/toast.service';
import {parsePermissionCarrier, stringifyPermissionCarrier} from '../../../../../../enums/permissions.enum';
import {
    MODULE_PERM_CATALOG,
    MODULE_PERM_GROUPS,
    parseModulePermissionCarrier,
    stringifyModulePermissionCarrier,
} from '../../../../../../enums/module-permissions.enum';
import {EMPTY_CARRIER, FlagCarrier} from '../../../../../../enums/flag-mask';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {guildFeatures} from '../../../../guild-features';
import {RoleChannelsComponent} from './role-channels/role-channels.component';
import {RoleRailComponent} from './role-rail/role-rail.component';
import {injectGuildRoster} from '../../../../shared/guild-roster';
import {countRoleOverrides, countVisibleChannels} from './role-stats';

interface RoleMemberDisplay {
    roleMember: RoleMemberDto;
    profile: ProfileDto | undefined;
}

/** Hex colours only; the free-text field used to accept anything and persist it. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

@Component({
    selector: 'app-roles-settings',
    imports: [
        NgClass,
        FormsModule,
        Button,
        InputText,
        Textarea,
        Dialog,
        Tooltip,
        PermissionToggleComponent,
        PrimeTemplate,
        TranslateModule,
        RoleChannelsComponent,
        RoleRailComponent,
    ],
    templateUrl: './roles-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RolesSettingsComponent implements OnInit {
    readonly guild = input.required<GuildDto>();
    rolesChanged = output<RoleDto[]>();
    /** Lets the modal shell guard nav-away and close while edits are pending. */
    dirtyChange = output<boolean>();
    readonly roles = signal<RoleDto[]>([]);
    readonly selectedRole = signal<RoleDto | null>(null);
    readonly activeTab = signal<'display' | 'permissions' | 'members' | 'channels'>('display');
    // Settings tab
    readonly editName = signal('');
    readonly editDescription = signal('');
    readonly editColor = signal('#4B5BC4');
    /** Carriers, not bare masks: a role can hold permissions this build has no name for, and editing one bit must not drop the rest on the way back out. */
    readonly editPerms = signal<FlagCarrier>(EMPTY_CARRIER);
    readonly editModulePerms = signal<FlagCarrier>(EMPTY_CARRIER);
    readonly editPermMask = computed(() => this.editPerms().value);
    readonly editModuleMask = computed(() => this.editModulePerms().value);
    readonly permQuery = signal('');
    readonly editSaving = signal(false);
    readonly editDirty = signal(false);
    /** Local unsaved-changes guard: the shell already blocks nav-away and close, but switching rows inside this page must also ask first, or it silently overwrites every edit signal. */
    readonly showUnsavedDialog = signal(false);
    // Create role dialog
    readonly showCreateDialog = signal(false);
    readonly createName = signal('');
    readonly createColor = signal('#4B5BC4');
    readonly creating = signal(false);
    // Delete role dialog
    readonly confirmDeleteRole = signal<RoleDto | null>(null);
    readonly showDeleteDialog = signal(false);
    readonly deleting = signal(false);
    readonly roleMembers = signal<RoleMemberDto[]>([]);
    readonly roleMembersLoading = signal(false);
    readonly roleMembersLoadingMore = signal(false);
    readonly roleMembersHasMore = signal(true);
    readonly roleMembersQuery = signal('');
    readonly roleMembersIsSearch = signal(false);
    readonly roleMembersLoaded = signal(false);
    readonly removing = signal<string | null>(null);
    // Add member dialog
    readonly showAddDialog = signal(false);
    readonly addSearch = signal('');
    readonly addCandidates = signal<GuildMemberDto[]>([]);
    readonly addLoading = signal(false);
    readonly adding = signal<string | null>(null);
    /** True while the candidate list is just the first page, so the dialog can say so. */
    readonly addPartial = signal(false);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private destroyRef = inject(DestroyRef);
    private profileService = inject(ProfileService);
    private brokenImages = inject(BrokenImageService);
    readonly roleMembersDisplay = computed<RoleMemberDisplay[]>(() =>
        this.roleMembers().map(rm => {
            const userId = rm.member?.userId ?? rm.userId ?? '';
            return {
                roleMember: rm,
                profile: userId ? this.profileService.getCachedByUserId(userId) : undefined,
            };
        }),
    );
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    /** Member ids known to already hold the selected role, used to filter add candidates. */
    private readonly assignedMemberIds = signal<ReadonlySet<string>>(new Set());
    // Members tab: raw list; profiles resolved from store
    protected readonly TAKE = 30;
    private memberNextSkip = 0;
    private memberSearchTimer?: ReturnType<typeof setTimeout>;
    private addSearchTimer?: ReturnType<typeof setTimeout>;

    /** What to run once the user confirms discarding pending edits. */
    private readonly pendingAction = signal<(() => void) | null>(null);

    /** Blocks Save on a malformed hex value instead of writing it to the role. */
    protected readonly colorInvalid = computed(() => !HEX_COLOR_PATTERN.test(this.editColor().trim()));

    /** The create dialog used to persist whatever was typed; it gets the same check as the editor. */
    protected readonly createColorInvalid = computed(
        () => !HEX_COLOR_PATTERN.test(this.createColor().trim()),
    );

    /** Module set for this guild: permission groups whose module is off aren't offered. */
    protected readonly features = computed(() => guildFeatures(this.guild()));

    protected readonly moduleCatalog = MODULE_PERM_CATALOG;

    /** No module on means no second grid at all, rather than an empty heading. */
    protected readonly hasModuleGroups = computed(() => {
        const features = this.features();
        return MODULE_PERM_GROUPS.some(group => !group.feature || features.has(group.feature));
    });

    private readonly roster = injectGuildRoster(() => this.guild().id, 'GUILD_SETTINGS.ROLES.UNKNOWN_MEMBER');

    /** Per role id, from the roster page the household boards already share; see its own size caveat. */
    protected readonly memberCounts = computed<ReadonlyMap<string, number>>(() => {
        const counts = new Map<string, number>();
        for (const member of this.roster.members()) {
            for (const rm of member.roleMembers ?? []) {
                counts.set(rm.role.id, (counts.get(rm.role.id) ?? 0) + 1);
            }
        }
        return counts;
    });

    protected readonly selectedMemberCount = computed(() => {
        const role = this.selectedRole();
        return role ? (this.memberCounts().get(role.id) ?? 0) : 0;
    });

    // injectGuildRoster pages at 200, so a guild past that undercounts and the number needs a "+".
    protected readonly memberCountAtCap = computed(() => this.roster.members().length >= 200);

    protected readonly totalChannels = computed(() => this.guild().channels.length);

    protected readonly overrideCount = computed(() => {
        const role = this.selectedRole();
        return role ? countRoleOverrides(role, this.guild().channels) : 0;
    });

    protected readonly visibleChannelCount = computed(() => {
        const role = this.selectedRole();
        return role ? countVisibleChannels(role, this.guild().channels) : 0;
    });

    protected get RoleType(): typeof RoleType {
        return RoleType;
    }

    constructor() {
        effect(() => this.dirtyChange.emit(this.editDirty()));
    }

    ngOnInit(): void {
        this.roles.set([...this.guild().roles].sort((a, b) => a.position - b.position));
        this.guildWsService.rolesReorderedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(dto => {
                const posMap = new Map(dto.roles.map(r => [r.roleId, r.position]));
                this.roles.update(list =>
                    list
                        .map(r => (posMap.has(r.id) ? {...r, position: posMap.get(r.id)!} : r))
                        .sort((a, b) => a.position - b.position),
                );
            });
    }

    /** The rail already validated the move; this just persists it and rolls back on failure. */
    onReorder(reordered: RoleDto[]): void {
        const previous = this.roles();
        this.roles.set(reordered);

        this.guildService
            .reorderRoles(this.guild().id, {
                roles: reordered.map(r => ({roleId: r.id, position: r.position})),
            })
            .subscribe({
                error: err => {
                    this.toastService.httpError(
                        this.translate.instant('GUILD_SETTINGS.ROLES.REORDER_ERROR'),
                        err,
                    );
                    this.roles.set(previous);
                },
            });
    }

    /** Clicking a role in the list discarded pending edits without a word. Ask first. */
    onRoleClick(role: RoleDto): void {
        if (this.selectedRole()?.id === role.id) return;
        this.guardUnsaved(() => this.selectRole(role));
    }

    /** Creating a role selects it, so it drops pending edits by the same route as a list click. */
    openCreateDialog(): void {
        this.guardUnsaved(() => this.showCreateDialog.set(true));
    }

    keepEditing(): void {
        this.showUnsavedDialog.set(false);
        this.pendingAction.set(null);
    }

    discardAndContinue(): void {
        const action = this.pendingAction();
        this.showUnsavedDialog.set(false);
        this.pendingAction.set(null);
        // Discard has to mean discard whatever the pending action was; the create path would otherwise leave the edits sitting there dirty after the user agreed to drop them.
        this.resetEdits();
        action?.();
    }

    /** Reset restores the editable fields and nothing else; it must not also empty the Members tab or bounce the user back to Display. */
    resetEdits(): void {
        const role = this.selectedRole();
        if (role) this.applyRoleToFields(role);
    }

    selectRole(role: RoleDto): void {
        this.selectedRole.set(role);
        this.applyRoleToFields(role);
        this.activeTab.set('display');
        this.resetMembersTab();
    }

    switchTab(tab: 'display' | 'permissions' | 'members' | 'channels'): void {
        this.activeTab.set(tab);
        if (tab === 'members' && !this.roleMembersLoaded()) {
            this.loadRoleMembers();
        }
    }

    onEditField(): void {
        const r = this.selectedRole();
        if (!r) return;
        this.editDirty.set(
            this.editName() !== r.name ||
                this.editDescription() !== (r.description ?? '') ||
                this.editColor() !== (r.color ?? '#4B5BC4') ||
                this.editPermMask() !== parsePermissionCarrier(r.permissions).value ||
                this.editModuleMask() !== parseModulePermissionCarrier(r.modulePermissions).value,
        );
    }

    // ── Settings tab ───────────────────────────────────────────────────────────

    onPermChange(mask: bigint): void {
        this.editPerms.update(carrier => ({...carrier, value: mask}));
        this.onEditField();
    }

    onModulePermChange(mask: bigint): void {
        this.editModulePerms.update(carrier => ({...carrier, value: mask}));
        this.onEditField();
    }

    saveRole(): void {
        const role = this.selectedRole();
        if (!role || this.editSaving() || this.colorInvalid()) return;
        this.editSaving.set(true);
        // Every field goes on every save, and an emptied one is sent as '' rather than dropped: PATCH leaves an omitted field alone now, so omission no longer clears anything.
        const dto: UpdateRoleDto = {
            name: this.editName(),
            description: this.editDescription(),
            color: this.editColor().trim(),
            permissions: stringifyPermissionCarrier(this.editPerms()),
            modulePermissions: stringifyModulePermissionCarrier(this.editModulePerms()),
        };
        this.guildService.updateRole(role.id, dto).subscribe({
            next: () => {
                const updated: RoleDto = {...role, ...dto};
                this.roles.update(list => list.map(r => (r.id === role.id ? updated : r)));
                this.selectedRole.set(updated);
                this.editDirty.set(false);
                this.editSaving.set(false);
                this.rolesChanged.emit(this.roles());
            },
            error: err => {
                this.editSaving.set(false);
                if (err.status === 403) {
                    this.toastService.error(this.translate.instant('GUILD_SETTINGS.ROLES.ESCALATION_ERROR'));
                } else {
                    this.toastService.httpError(
                        this.translate.instant('GUILD_SETTINGS.ROLES.SAVE_ERROR'),
                        err,
                    );
                }
            },
        });
    }

    createRole(): void {
        if (this.creating() || !this.createName().trim() || this.createColorInvalid()) return;
        this.creating.set(true);
        const dto: CreateRoleDto = {
            guildId: this.guild().id,
            name: this.createName().trim(),
            color: this.createColor().trim(),
            permissions: 'None',
            modulePermissions: 'None',
        };
        this.guildService.createRole(dto).subscribe({
            next: role => {
                this.roles.update(list => [...list, role]);
                this.showCreateDialog.set(false);
                this.createName.set('');
                this.createColor.set('#4B5BC4');
                this.creating.set(false);
                this.selectRole(role);
                this.rolesChanged.emit(this.roles());
            },
            error: err => {
                this.creating.set(false);
                if (err.status === 403) {
                    this.toastService.error(this.translate.instant('GUILD_SETTINGS.ROLES.ESCALATION_ERROR'));
                } else {
                    this.toastService.httpError(
                        this.translate.instant('GUILD_SETTINGS.ROLES.CREATE_ERROR'),
                        err,
                    );
                }
            },
        });
    }

    deleteRole(role: RoleDto): void {
        if (this.deleting()) return;
        this.deleting.set(true);
        this.guildService.deleteRole(role.id).subscribe({
            next: () => {
                this.roles.update(list => list.filter(r => r.id !== role.id));
                if (this.selectedRole()?.id === role.id) this.selectedRole.set(null);
                this.confirmDeleteRole.set(null);
                this.showDeleteDialog.set(false);
                this.deleting.set(false);
                this.rolesChanged.emit(this.roles());
            },
            error: err => {
                this.deleting.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.DELETE_ERROR'), err);
            },
        });
    }

    loadMoreRoleMembers(): void {
        const role = this.selectedRole();
        if (!role || this.roleMembersLoadingMore() || !this.roleMembersHasMore() || this.roleMembersLoading())
            return;
        this.roleMembersLoadingMore.set(true);
        this.fetchMembersPage(role.id);
    }

    // ── Members tab ────────────────────────────────────────────────────────────

    onMembersScroll(event: Event): void {
        if (this.roleMembersIsSearch()) return;
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
            this.loadMoreRoleMembers();
        }
    }

    onQueryChange(query: string): void {
        this.roleMembersQuery.set(query);
        clearTimeout(this.memberSearchTimer);
        this.memberSearchTimer = setTimeout(() => {
            if (query.trim()) {
                this.roleMembersIsSearch.set(true);
                this.doMemberSearch(query.trim());
            } else {
                this.roleMembersIsSearch.set(false);
                this.loadRoleMembers();
            }
        }, 300);
    }

    removeMember(rm: RoleMemberDto): void {
        const role = this.selectedRole();
        if (!role || this.removing()) return;
        this.removing.set(rm.memberId);
        this.guildService.removeRoleFromMember(role.id, rm.memberId).subscribe({
            next: () => {
                this.roleMembers.update(list => list.filter(r => r.memberId !== rm.memberId));
                this.removing.set(null);
            },
            error: err => {
                this.removing.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.REMOVE_ERROR'), err);
            },
        });
    }

    // A half-printed user id is not a name; while the profile resolves, say so in words.
    displayName(profile: ProfileDto | undefined): string {
        return profile?.userName ?? this.translate.instant('GUILD_SETTINGS.ROLES.UNKNOWN_MEMBER');
    }

    // The API sends an avatarUrl for every profile, uploaded or not, so a URL that has already failed is the only signal that this member has no avatar. See BrokenImageService.
    avatarUrl(profile: ProfileDto | undefined): string | undefined {
        const url = profile?.avatarUrl;
        return this.brokenImages.isBroken(url) ? undefined : url;
    }

    onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    openAddDialog(): void {
        this.addSearch.set('');
        this.addCandidates.set([]);
        this.addPartial.set(false);
        this.showAddDialog.set(true);

        // Exclusion is computed from the role's current members; opening this dialog without visiting the Members tab first left that set empty, so members who already held the role were offered as candidates.
        const role = this.selectedRole();
        if (role && !this.roleMembersLoaded()) {
            this.addLoading.set(true);
            this.guildService.getRoleMembers(role.id, 0, this.TAKE).subscribe({
                next: incoming => {
                    this.assignedMemberIds.update(ids => {
                        const next = new Set(ids);
                        incoming.forEach(rm => next.add(rm.memberId));
                        return next;
                    });
                    this.fetchAddCandidates('');
                },
                error: () => this.fetchAddCandidates(''),
            });
            return;
        }
        this.fetchAddCandidates('');
    }

    onAddSearchChange(query: string): void {
        this.addSearch.set(query);
        clearTimeout(this.addSearchTimer);
        this.addSearchTimer = setTimeout(() => this.fetchAddCandidates(query.trim()), 300);
    }

    addMember(member: GuildMemberDto): void {
        const role = this.selectedRole();
        if (!role || this.adding()) return;
        this.adding.set(member.id);
        this.guildService.assignRoleToMember(role.id, member.id).subscribe({
            next: () => {
                this.addCandidates.update(list => list.filter(m => m.id !== member.id));
                this.assignedMemberIds.update(ids => new Set(ids).add(member.id));
                this.adding.set(null);
                this.resetMembersTab();
                this.loadRoleMembers();
            },
            error: err => {
                this.adding.set(null);
                // assignedMemberIds only ever holds the pages we fetched, so on a big role this list can still offer someone who already has it; the server treats a repeat as a no-op, but if it does answer 409 that is not a failure worth a red toast.
                if (err.status === 409) {
                    this.addCandidates.update(list => list.filter(m => m.id !== member.id));
                    this.assignedMemberIds.update(ids => new Set(ids).add(member.id));
                    this.toastService.info(this.translate.instant('GUILD_SETTINGS.ROLES.ALREADY_HAS_ROLE'));
                    return;
                }
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.ADD_ERROR'), err);
            },
        });
    }

    addDisplayName(member: GuildMemberDto): string {
        return this.displayName(member.profile);
    }

    // ── Add member dialog ──────────────────────────────────────────────────────

    addAvatarUrl(member: GuildMemberDto): string | undefined {
        return this.avatarUrl(member.profile);
    }

    private guardUnsaved(action: () => void): void {
        if (!this.editDirty()) {
            action();
            return;
        }
        this.pendingAction.set(action);
        this.showUnsavedDialog.set(true);
    }

    private applyRoleToFields(role: RoleDto): void {
        this.editName.set(role.name);
        this.editDescription.set(role.description ?? '');
        this.editColor.set(role.color ?? '#4B5BC4');
        this.editPerms.set(parsePermissionCarrier(role.permissions));
        this.editModulePerms.set(parseModulePermissionCarrier(role.modulePermissions));
        this.permQuery.set('');
        this.editDirty.set(false);
    }

    private resetMembersTab(): void {
        this.roleMembers.set([]);
        this.assignedMemberIds.set(new Set());
        this.roleMembersLoaded.set(false);
        this.roleMembersQuery.set('');
        this.roleMembersIsSearch.set(false);
        this.roleMembersHasMore.set(true);
        this.memberNextSkip = 0;
    }

    private loadRoleMembers(): void {
        const role = this.selectedRole();
        if (!role) return;
        this.roleMembersLoading.set(true);
        this.memberNextSkip = 0;
        this.roleMembers.set([]);
        this.roleMembersHasMore.set(true);
        this.fetchMembersPage(role.id);
    }

    private fetchMembersPage(roleId: string): void {
        const skip = this.memberNextSkip;
        this.guildService.getRoleMembers(roleId, skip, this.TAKE).subscribe({
            next: incoming => {
                incoming.forEach(rm => {
                    const uid = rm.member?.userId ?? rm.userId;
                    if (uid) this.profileService.resolveByUserId(uid);
                });
                this.assignedMemberIds.update(ids => {
                    const next = new Set(ids);
                    incoming.forEach(rm => next.add(rm.memberId));
                    return next;
                });
                if (skip === 0) {
                    this.roleMembers.set(incoming);
                    this.roleMembersLoading.set(false);
                    this.roleMembersLoaded.set(true);
                } else {
                    this.roleMembers.update(list => [...list, ...incoming]);
                    this.roleMembersLoadingMore.set(false);
                }
                this.memberNextSkip = skip + incoming.length;
                if (incoming.length < this.TAKE) this.roleMembersHasMore.set(false);
            },
            error: () => {
                this.roleMembersLoading.set(false);
                this.roleMembersLoadingMore.set(false);
            },
        });
    }

    private doMemberSearch(query: string): void {
        const role = this.selectedRole();
        if (!role) return;
        this.roleMembersLoading.set(true);
        this.guildService.searchRoleMembers(role.id, query).subscribe({
            next: results => {
                results.forEach(rm => {
                    const uid = rm.member?.userId ?? rm.userId;
                    if (uid) this.profileService.resolveByUserId(uid);
                });
                this.roleMembers.set(results);
                this.roleMembersLoading.set(false);
            },
            error: () => this.roleMembersLoading.set(false),
        });
    }

    private fetchAddCandidates(query: string): void {
        this.addLoading.set(true);
        const obs = query
            ? this.guildService.searchMembers(this.guild().id, query)
            : this.guildService.getMembers(this.guild().id, 0, this.TAKE);
        obs.subscribe({
            next: members => {
                const existingIds = this.assignedMemberIds();
                // The unsearched list is one page of the guild, never the whole roster.
                this.addPartial.set(!query && members.length >= this.TAKE);
                this.addCandidates.set(members.filter(m => !existingIds.has(m.id)));
                this.addLoading.set(false);
            },
            error: () => {
                this.addPartial.set(false);
                this.addLoading.set(false);
            },
        });
    }
}
