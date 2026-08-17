import {Component, computed, effect, inject, input, OnInit, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto, RoleMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuestAccessApiService} from '../../../../../../services/guest-access-api.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {BrokenImageService} from '../../../../../../services/broken-image.service';
import {ToastService} from '../../../../../../services/toast.service';
import {RelativeTimePipe} from '../../../../../../pipes/relative-time.pipe';
import {ModulePermissions} from '../../../../../../enums/module-permissions.enum';
import {guildAbilities} from '../../../../guild-permissions';
import {GUEST_DURATIONS, grantState, guestExpiryFromNow} from '../../../../guest-access';

/** How many members the picker asks for when nothing has been typed. */
const CANDIDATE_PAGE = 30;

interface GrantRow {
    userId: string;
    displayName: string;
    /** False while the profile is still resolving, so the row draws a placeholder and not an id. */
    named: boolean;
    avatarUrl: string | undefined;
    expiresAt: string;
    lapsed: boolean;
}

/** Guest access: hand someone a role that ends on its own. There is no "list temporary grants" endpoint, so this reads the ordinary role-members listing and classifies each row through `grantState`, since that listing keeps returning grants for about a week after they lapse. */
@Component({
    selector: 'app-guest-access-settings',
    imports: [
        FormsModule,
        Button,
        InputText,
        Select,
        Dialog,
        Tooltip,
        PrimeTemplate,
        TranslateModule,
        RelativeTimePipe,
    ],
    templateUrl: './guest-access-settings.component.html',
})
export class GuestAccessSettingsComponent implements OnInit {
    readonly guild = input.required<GuildDto>();

    protected readonly DURATIONS = GUEST_DURATIONS;
    protected readonly candidatePage = CANDIDATE_PAGE;

    protected readonly selectedRoleId = signal<string | null>(null);
    protected readonly loading = signal(false);
    protected readonly rows = signal<RoleMemberDto[]>([]);
    /** Moved on every mutation and on load, so a grant that lapses while the page is open moves. */
    protected readonly now = signal(Date.now());

    protected readonly canManage = signal(false);
    protected readonly permsLoaded = signal(false);

    // ── Grant dialog ────────────────────────────────────────────────────────
    protected readonly showGrant = signal(false);
    protected readonly search = signal('');
    protected readonly candidates = signal<GuildMemberDto[]>([]);
    protected readonly searching = signal(false);
    /** The unsearched load came back full, so there are members the picker is not showing. */
    protected readonly candidatesTruncated = signal(false);
    protected readonly durationMs = signal<number>(GUEST_DURATIONS[3].ms);
    /** The member picked out of the list, waiting on a yes; picking a name must not grant immediately, since the duration select sits above the list and its value is easy to never read. */
    protected readonly pendingGrant = signal<GuildMemberDto | null>(null);
    protected readonly granting = signal<string | null>(null);
    protected readonly revoking = signal<string | null>(null);

    private guildService = inject(GuildService);
    private api = inject(GuestAccessApiService);
    private profiles = inject(ProfileService);
    private brokenImages = inject(BrokenImageService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private searchTimer?: ReturnType<typeof setTimeout>;

    /** @everyone is not a role anyone hands out temporarily; everybody already has it. */
    protected readonly assignableRoles = computed(() =>
        this.guild()
            .roles.filter(r => r.type !== RoleType.Everyone)
            .sort((a, b) => b.position - a.position),
    );

    protected readonly durationOptions = computed(() =>
        GUEST_DURATIONS.map(d => ({ms: d.ms, label: this.translate.instant(d.labelKey)})),
    );

    protected readonly selectedRole = computed<RoleDto | null>(
        () => this.assignableRoles().find(r => r.id === this.selectedRoleId()) ?? null,
    );

    /** When the pending grant would end, resolved against the clock rather than left as "1 week". */
    protected readonly grantEndsAt = computed(() => guestExpiryFromNow(this.durationMs(), this.now()));

    protected readonly grantEndsLabel = computed(() => {
        const iso = this.grantEndsAt();
        return iso ? this.absoluteLabel(iso) : '';
    });

    private readonly classified = computed(() => {
        const now = this.now();
        return this.rows()
            .map(rm => ({
                rm,
                userId: rm.member?.userId ?? rm.userId ?? '',
                state: grantState(rm.expiresAt, now),
            }))
            .filter(x => x.userId);
    });

    protected readonly liveGrants = computed<GrantRow[]>(() =>
        this.classified()
            .filter(x => x.state === 'live')
            .map(x => this.toRow(x.userId, x.rm, false))
            .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)),
    );

    /** Grants that have already ended but whose rows the server has not reaped yet; shown, but shown as ended, since the alternative implies the pet sitter still has the door code. */
    protected readonly lapsedGrants = computed<GrantRow[]>(() =>
        this.classified()
            .filter(x => x.state === 'lapsed')
            .map(x => this.toRow(x.userId, x.rm, true)),
    );

    /** Ordinary permanent members of the role, which guest access has nothing to say about. */
    protected readonly permanentCount = computed(
        () => this.classified().filter(x => x.state === 'permanent').length,
    );

    protected readonly grantCandidates = computed(() => {
        const held = new Set(
            this.classified()
                .filter(x => x.state !== 'lapsed')
                .map(x => x.userId),
        );
        return this.candidates().filter(m => !held.has(m.userId));
    });

    constructor() {
        effect(() => {
            const roleId = this.selectedRoleId();
            if (!roleId) return;
            untracked(() => this.loadRoleMembers(roleId));
        });

        // A grant that runs out while this page is open has to move to Ended by itself; one timer for the page rather than one per row, since the rows are already recomputed from `now`.
        const timer = setInterval(() => this.now.set(Date.now()), 60_000);
        effect(onCleanup => onCleanup(() => clearInterval(timer)));
    }

    ngOnInit(): void {
        this.guildService.getOwnMember(this.guild().id).subscribe({
            next: member => {
                const abilities = guildAbilities(member, this.guild(), member.userId);
                this.canManage.set(abilities.canModule(ModulePermissions.ManageGuests));
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
        this.candidatesTruncated.set(false);
        this.pendingGrant.set(null);
        this.durationMs.set(GUEST_DURATIONS[3].ms);
        this.showGrant.set(true);
        this.fetchCandidates('');
    }

    protected onSearchChange(query: string): void {
        this.search.set(query);
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.fetchCandidates(query.trim()), 300);
    }

    /** Picking a name only proposes the grant; `confirmGrant` is what hands out the role. */
    protected askGrant(member: GuildMemberDto): void {
        this.now.set(Date.now());
        this.pendingGrant.set(member);
    }

    protected cancelPendingGrant(): void {
        this.pendingGrant.set(null);
    }

    protected confirmGrant(): void {
        const member = this.pendingGrant();
        const role = this.selectedRole();
        if (!member || !role || this.granting()) return;
        const expiresAt = guestExpiryFromNow(this.durationMs());
        if (!expiresAt) {
            this.toast.error(this.translate.instant('GUEST_ACCESS.ERROR.BAD_DURATION'));
            return;
        }

        this.granting.set(member.userId);
        this.api.grant(this.guild().id, member.userId, role.id, expiresAt).subscribe({
            next: () => {
                this.granting.set(null);
                this.pendingGrant.set(null);
                this.showGrant.set(false);
                this.toast.success(
                    this.translate.instant('GUEST_ACCESS.GRANT_SUCCESS', {
                        name: this.candidateName(member),
                        role: role.name,
                        time: this.absoluteLabel(expiresAt),
                    }),
                    {detail: this.translate.instant('GUEST_ACCESS.GRANT_SUCCESS_DETAIL')},
                );
                this.loadRoleMembers(role.id);
            },
            error: (err: HttpErrorResponse) => {
                this.granting.set(null);
                // Same shape the roles page uses: the hierarchy rule is the server's, and a 403 on an assignment is what it looks like from here.
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

    /** The date and time a grant ends; the rows lead with "expires in six hours" instead, and this is what the hover reveals behind it. */
    protected expiryLabel(row: GrantRow): string {
        return this.absoluteLabel(row.expiresAt);
    }

    // The API sends an avatarUrl for every profile, uploaded or not, so a URL that has already failed is the only signal that this user has no avatar. See BrokenImageService.
    protected avatarUrl(row: GrantRow): string | undefined {
        return this.brokenImages.isBroken(row.avatarUrl) ? undefined : row.avatarUrl;
    }

    protected onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    protected candidateName(member: GuildMemberDto): string {
        return member.profile?.userName ?? this.translate.instant('GUEST_ACCESS.UNKNOWN_MEMBER');
    }

    private absoluteLabel(iso: string): string {
        const at = new Date(iso);
        if (Number.isNaN(at.getTime())) return '';
        return `${at.toLocaleDateString()} ${at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    }

    private toRow(userId: string, rm: RoleMemberDto, lapsed: boolean): GrantRow {
        const profile = this.profiles.getCachedByUserId(userId);
        return {
            userId,
            displayName: profile?.userName ?? this.translate.instant('GUEST_ACCESS.UNKNOWN_MEMBER'),
            named: !!profile?.userName,
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
            : this.guildService.getMembers(this.guild().id, 0, CANDIDATE_PAGE);
        obs.subscribe({
            next: members => {
                this.candidates.set(members);
                // A full page back from the unsearched load means there are almost certainly members missing from the picker, and nothing on screen would otherwise say so.
                this.candidatesTruncated.set(!query && members.length >= CANDIDATE_PAGE);
                this.searching.set(false);
            },
            error: () => this.searching.set(false),
        });
    }
}
