import {Component, computed, DestroyRef, effect, inject, input, OnInit, output, signal} from '@angular/core';
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
import {ToastService} from '../../../../../../services/toast.service';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {guildFeatures} from '../../../../guild-features';

interface RoleMemberDisplay {
    roleMember: RoleMemberDto;
    profile: ProfileDto | undefined;
    userId: string;
}

/** Hex colours only; the free-text field used to accept anything and persist it. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

@Component({
    selector: 'app-roles-settings',
    imports: [NgClass, FormsModule, Button, InputText, Textarea, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate, TranslateModule],
    templateUrl: './roles-settings.component.html',
})
export class RolesSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    rolesChanged = output<RoleDto[]>();
    /** Lets the modal shell guard nav-away and close while edits are pending. */
    dirtyChange = output<boolean>();
    roles = signal<RoleDto[]>([]);
    selectedRole = signal<RoleDto | null>(null);
    activeTab = signal<'settings' | 'members'>('settings');
    // Settings tab
    editName = signal('');
    editDescription = signal('');
    editColor = signal('#4B5BC4');
    editPermMask = signal(0n);
    editSaving = signal(false);
    editDirty = signal(false);
    // Create role dialog
    showCreateDialog = signal(false);
    createName = signal('');
    createColor = signal('#4B5BC4');
    creating = signal(false);
    // Delete role dialog
    confirmDeleteRole = signal<RoleDto | null>(null);
    showDeleteDialog = signal(false);
    deleting = signal(false);
    roleMembers = signal<RoleMemberDto[]>([]);
    roleMembersLoading = signal(false);
    roleMembersLoadingMore = signal(false);
    roleMembersHasMore = signal(true);
    roleMembersQuery = signal('');
    roleMembersIsSearch = signal(false);
    roleMembersLoaded = signal(false);
    removing = signal<string | null>(null);
    // Add member dialog
    showAddDialog = signal(false);
    addSearch = signal('');
    addCandidates = signal<GuildMemberDto[]>([]);
    addLoading = signal(false);
    adding = signal<string | null>(null);
    protected readonly RoleType = RoleType;
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private destroyRef = inject(DestroyRef);
    private profileService = inject(ProfileService);
    roleMembersDisplay = computed<RoleMemberDisplay[]>(() =>
        this.roleMembers().map(rm => {
            const userId = rm.member?.userId ?? rm.userId ?? '';
            return {
                roleMember: rm,
                profile: userId ? this.profileService.getCachedByUserId(userId) : undefined,
                userId,
            };
        })
    );
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    /** Member ids known to already hold the selected role, used to filter add candidates. */
    private assignedMemberIds = signal<ReadonlySet<string>>(new Set());
    // Members tab -raw list; profiles resolved from store
    private readonly TAKE = 30;
    private memberNextSkip = 0;
    private memberSearchTimer?: ReturnType<typeof setTimeout>;
    private addSearchTimer?: ReturnType<typeof setTimeout>;

    /** Blocks Save on a malformed hex value instead of writing it to the role. */
    protected colorInvalid = computed(() => !HEX_COLOR_PATTERN.test(this.editColor().trim()));

    /** Module set for this guild: permission groups whose module is off aren't offered. */
    protected features = computed(() => guildFeatures(this.guild()));

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
                    list.map(r => posMap.has(r.id) ? {...r, position: posMap.get(r.id)!} : r)
                        .sort((a, b) => a.position - b.position)
                );
            });
    }

    private dragIndex = signal<number | null>(null);

    onDragStart(index: number): void {
        this.dragIndex.set(index);
    }

    onDragOver(event: DragEvent): void {
        event.preventDefault();
    }

    onDrop(targetIndex: number): void {
        const fromIndex = this.dragIndex();
        this.dragIndex.set(null);
        if (fromIndex === null) return;
        this.moveRole(fromIndex, targetIndex);
    }

    /** Keyboard path to reordering; drag-and-drop alone left this unusable without a mouse. */
    moveRoleBy(index: number, delta: number): void {
        this.moveRole(index, index + delta);
    }

    canMove(index: number, delta: number): boolean {
        const target = index + delta;
        return target >= 0 && target < this.roles().length;
    }

    private moveRole(fromIndex: number, targetIndex: number): void {
        if (fromIndex === targetIndex) return;
        if (targetIndex < 0 || targetIndex >= this.roles().length) return;

        const reordered = [...this.roles()];
        const [moved] = reordered.splice(fromIndex, 1);
        reordered.splice(targetIndex, 0, moved);
        const withPositions = reordered.map((r, i) => ({...r, position: i}));
        this.roles.set(withPositions);

        this.guildService.reorderRoles(this.guild().id, {
            roles: withPositions.map(r => ({roleId: r.id, position: r.position})),
        }).subscribe({
            error: err => {
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.REORDER_ERROR'), err);
                this.roles.set([...this.guild().roles].sort((a, b) => a.position - b.position));
            },
        });
    }

    selectRole(role: RoleDto): void {
        this.selectedRole.set(role);
        this.editName.set(role.name);
        this.editDescription.set(role.description ?? '');
        this.editColor.set(role.color ?? '#4B5BC4');
        this.editPermMask.set(parsePermissions(role.permissions));
        this.editDirty.set(false);
        this.activeTab.set('settings');
        this.resetMembersTab();
    }

    switchTab(tab: 'settings' | 'members'): void {
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
            this.editPermMask() !== parsePermissions(r.permissions)
        );
    }

    // ── Settings tab ───────────────────────────────────────────────────────────

    onPermChange(mask: bigint): void {
        this.editPermMask.set(mask);
        this.onEditField();
    }

    saveRole(): void {
        const role = this.selectedRole();
        if (!role || this.editSaving() || this.colorInvalid()) return;
        this.editSaving.set(true);
        const dto: UpdateRoleDto = {
            name: this.editName(),
            description: this.editDescription(),
            color: this.editColor().trim(),
            permissions: stringifyPermissions(this.editPermMask()),
        };
        this.guildService.updateRole(role.id, dto).subscribe({
            next: () => {
                const updated: RoleDto = {...role, ...dto};
                this.roles.update(list => list.map(r => r.id === role.id ? updated : r));
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
                    this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.SAVE_ERROR'), err);
                }
            },
        });
    }

    createRole(): void {
        if (this.creating() || !this.createName().trim()) return;
        this.creating.set(true);
        const dto: CreateRoleDto = {
            guildId: this.guild().id,
            name: this.createName().trim(),
            color: this.createColor(),
            permissions: '0',
        };
        this.guildService.createRole(dto).subscribe({
            next: role => {
                this.roles.update(list => [...list, role]);
                this.showCreateDialog.set(false);
                this.createName.set('');
                this.creating.set(false);
                this.selectRole(role);
                this.rolesChanged.emit(this.roles());
            },
            error: err => {
                this.creating.set(false);
                if (err.status === 403) {
                    this.toastService.error(this.translate.instant('GUILD_SETTINGS.ROLES.ESCALATION_ERROR'));
                } else {
                    this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.CREATE_ERROR'), err);
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
        if (!role || this.roleMembersLoadingMore() || !this.roleMembersHasMore() || this.roleMembersLoading()) return;
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

    displayName(profile: ProfileDto | undefined, userId: string): string {
        return profile?.userName ?? (userId ? userId.slice(0, 8) + '…' : '?');
    }

    openAddDialog(): void {
        this.addSearch.set('');
        this.addCandidates.set([]);
        this.showAddDialog.set(true);

        // Exclusion is computed from the role's current members. Opening this dialog
        // without visiting the Members tab first left that set empty, so members who
        // already held the role were offered as candidates.
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
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.ROLES.ADD_ERROR'), err);
            },
        });
    }

    addDisplayName(member: GuildMemberDto): string {
        return member.profile?.userName ?? member.userId.slice(0, 8) + '…';
    }

    // ── Add member dialog ──────────────────────────────────────────────────────

    addAvatarUrl(member: GuildMemberDto): string | undefined {
        return member.profile?.avatarUrl;
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
            : this.guildService.getMembers(this.guild().id, 0, 30);
        obs.subscribe({
            next: members => {
                const existingIds = this.assignedMemberIds();
                this.addCandidates.set(members.filter(m => !existingIds.has(m.id)));
                this.addLoading.set(false);
            },
            error: () => this.addLoading.set(false),
        });
    }
}
