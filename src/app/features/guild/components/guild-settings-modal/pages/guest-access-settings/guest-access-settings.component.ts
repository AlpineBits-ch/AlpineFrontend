import {Component, computed, effect, inject, input, OnInit, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto, RoleMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuestAccessApiService} from '../../../../../../services/guest-access-api.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {hasPermission, Permissions} from '../../../../../../enums/permissions.enum';
import {effectiveGuildPermissions} from '../../../../guild-permissions';
import {GUEST_DURATIONS, grantState, guestExpiryFromNow} from '../../../../guest-access';

interface GrantRow {
    userId: string;
    displayName: string;
    avatarUrl: string | undefined;
    expiresAt: string;
    lapsed: boolean;
}

/**
 * Guest access: hand someone a role that ends on its own.
 *
 * <p>There is no "list temporary grants" endpoint, so this reads the ordinary role-members listing
 * for the selected role and picks out the rows carrying an `expiresAt`. That listing keeps
 * returning grants for about a week after they lapse, which is why every row here is classified
 * through `grantState` instead of being drawn as access simply because it came back.</p>
 */
@Component({
    selector: 'app-guest-access-settings',
    imports: [FormsModule, Button, InputText, Select, Dialog, PrimeTemplate, TranslateModule],
    templateUrl: './guest-access-settings.component.html',
})
export class GuestAccessSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    protected readonly DURATIONS = GUEST_DURATIONS;

    protected selectedRoleId = signal<string | null>(null);
    protected loading = signal(false);
    protected rows = signal<RoleMemberDto[]>([]);
    /** Moved on every mutation and on load, so a grant that lapses while the page is open moves. */
    protected now = signal(Date.now());

    protected canManage = signal(false);
    protected permsLoaded = signal(false);

    // ── Grant dialog ────────────────────────────────────────────────────────
    protected showGrant = signal(false);
    protected search = signal('');
    protected candidates = signal<GuildMemberDto[]>([]);
    protected searching = signal(false);
    protected durationMs = signal<number>(GUEST_DURATIONS[3].ms);
    protected granting = signal<string | null>(null);
    protected revoking = signal<string | null>(null);

    private guildService = inject(GuildService);
    private api = inject(GuestAccessApiService);
    private profiles = inject(ProfileService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private searchTimer?: ReturnType<typeof setTimeout>;

    /** @everyone is not a role anyone hands out temporarily; everybody already has it. */
    protected assignableRoles = computed(() =>
        this.guild().roles
            .filter(r => r.type !== RoleType.Everyone)
            .sort((a, b) => b.position - a.position));

    protected durationOptions = computed(() =>
        GUEST_DURATIONS.map(d => ({ms: d.ms, label: this.translate.instant(d.labelKey)})));

    protected selectedRole = computed<RoleDto | null>(() =>
        this.assignableRoles().find(r => r.id === this.selectedRoleId()) ?? null);

    private classified = computed(() => {
        const now = this.now();
        return this.rows()
            .map(rm => ({rm, userId: rm.member?.userId ?? rm.userId ?? '', state: grantState(rm.expiresAt, now)}))
            .filter(x => x.userId);
    });

    protected liveGrants = computed<GrantRow[]>(() =>
        this.classified().filter(x => x.state === 'live').map(x => this.toRow(x.userId, x.rm, false))
            .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)));

    /**
     * Grants that have already ended but whose rows the server has not reaped yet. Shown, but
     * shown as *ended* - the alternative is a listing that quietly implies the pet sitter still
     * has the door code.
     */
    protected lapsedGrants = computed<GrantRow[]>(() =>
        this.classified().filter(x => x.state === 'lapsed').map(x => this.toRow(x.userId, x.rm, true)));

    /** Ordinary permanent members of the role, which guest access has nothing to say about. */
    protected permanentCount = computed(() => this.classified().filter(x => x.state === 'permanent').length);

    protected grantCandidates = computed(() => {
        const held = new Set(this.classified().filter(x => x.state !== 'lapsed').map(x => x.userId));
        return this.candidates().filter(m => !held.has(m.userId));
    });

    constructor() {
        effect(() => {
            const roleId = this.selectedRoleId();
            if (!roleId) return;
            untracked(() => this.loadRoleMembers(roleId));
        });

        // A grant that runs out while this page is open has to move to Ended by itself. One timer
        // for the page rather than one per row: the rows are already recomputed from `now`.
        const timer = setInterval(() => this.now.set(Date.now()), 60_000);
        effect(onCleanup => onCleanup(() => clearInterval(timer)));
    }

    ngOnInit(): void {
        this.guildService.getOwnMember(this.guild().id).subscribe({
            next: member => {
                const perms = effectiveGuildPermissions(member);
                this.canManage.set(
                    hasPermission(perms, Permissions.ManageGuests)
                    || hasPermission(perms, Permissions.Superadmin)
                    || member.userId === this.guild().ownerId);
                this.permsLoaded.set(true);
            },
            // Failing closed: an unproven permission must not render grant controls.
            error: () => this.permsLoaded.set(true),
        });
        const first = this.assignableRoles()[0];
        if (first) this.selectedRoleId.set(first.id);
    }

    protected selectRole(role: RoleDto): void {
        this.selectedRoleId.set(role.id);
    }

    protected openGrant(): void {
        this.search.set('');
        this.candidates.set([]);
        this.durationMs.set(GUEST_DURATIONS[3].ms);
        this.showGrant.set(true);
        this.fetchCandidates('');
    }

    protected onSearchChange(query: string): void {
        this.search.set(query);
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.fetchCandidates(query.trim()), 300);
    }

    protected grant(member: GuildMemberDto): void {
        const role = this.selectedRole();
        if (!role || this.granting()) return;
        const expiresAt = guestExpiryFromNow(this.durationMs());
        if (!expiresAt) {
            this.toast.error(this.translate.instant('GUEST_ACCESS.ERROR.BAD_DURATION'));
            return;
        }

        this.granting.set(member.userId);
        this.api.grant(this.guild().id, member.userId, role.id, expiresAt).subscribe({
            next: () => {
                this.granting.set(null);
                this.showGrant.set(false);
                this.loadRoleMembers(role.id);
            },
            error: (err: HttpErrorResponse) => {
                this.granting.set(null);
                // Same shape the roles page uses: the hierarchy rule is the server's, and a 403 on
                // an assignment is what it looks like from here.
                if (err.status === 403) {
                    this.toast.error(this.translate.instant('GUILD_SETTINGS.ROLES.ESCALATION_ERROR'));
                    return;
                }
                this.toast.httpError(this.translate.instant('GUEST_ACCESS.GRANT_ERROR'), err);
            },
        });
    }

    protected revoke(row: GrantRow): void {
        const role = this.selectedRole();
        if (!role || this.revoking()) return;
        this.revoking.set(row.userId);
        this.api.revoke(this.guild().id, row.userId, role.id).subscribe({
            next: () => {
                this.revoking.set(null);
                this.rows.update(list => list.filter(rm => (rm.member?.userId ?? rm.userId) !== row.userId));
            },
            error: (err: HttpErrorResponse) => {
                this.revoking.set(null);
                if (err.status === 403) {
                    this.toast.error(this.translate.instant('GUILD_SETTINGS.ROLES.ESCALATION_ERROR'));
                    return;
                }
                this.toast.httpError(this.translate.instant('GUEST_ACCESS.REVOKE_ERROR'), err);
            },
        });
    }

    protected expiryLabel(row: GrantRow): string {
        const at = new Date(row.expiresAt);
        return `${at.toLocaleDateString()} ${at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    }

    protected candidateName(member: GuildMemberDto): string {
        return member.profile?.userName ?? member.userId.slice(0, 8) + '…';
    }

    private toRow(userId: string, rm: RoleMemberDto, lapsed: boolean): GrantRow {
        const profile = this.profiles.getCachedByUserId(userId);
        return {
            userId,
            displayName: profile?.userName ?? userId.slice(0, 8) + '…',
            avatarUrl: profile?.avatarUrl,
            expiresAt: rm.expiresAt ?? '',
            lapsed,
        };
    }

    private loadRoleMembers(roleId: string): void {
        this.loading.set(true);
        this.rows.set([]);
        // 200 is well past any household's roster; guest grants are not a paged surface.
        this.guildService.getRoleMembers(roleId, 0, 200).subscribe({
            next: incoming => {
                incoming.forEach(rm => {
                    const uid = rm.member?.userId ?? rm.userId;
                    if (uid) this.profiles.resolveByUserId(uid);
                });
                this.now.set(Date.now());
                this.rows.set(incoming);
                this.loading.set(false);
            },
            error: () => this.loading.set(false),
        });
    }

    private fetchCandidates(query: string): void {
        this.searching.set(true);
        const obs = query
            ? this.guildService.searchMembers(this.guild().id, query)
            : this.guildService.getMembers(this.guild().id, 0, 30);
        obs.subscribe({
            next: members => {
                this.candidates.set(members);
                this.searching.set(false);
            },
            error: () => this.searching.set(false),
        });
    }
}
