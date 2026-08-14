import {Component, computed, DestroyRef, inject, input, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {catchError, EMPTY, from, map, mergeMap, Subscription} from 'rxjs';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {BanDto} from '../../../../../../dtos/response/ban.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {BrokenImageService} from '../../../../../../services/broken-image.service';
import {ToastService} from '../../../../../../services/toast.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

interface BanRow {
    ban: BanDto;
    profile: ProfileDto | null;
}

/**
 * How the ban dialog picks its target. `member` searches this guild's member list; `id` is the
 * escape hatch for someone who has already left, who no member search can return.
 */
type BanMode = 'member' | 'id';

@Component({
    selector: 'app-bans-settings',
    imports: [FormsModule, Button, InputText, Dialog, TranslateModule, PrimeTemplate, DatePipe],
    templateUrl: './bans-settings.component.html',
})
export class BansSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    bans = signal<BanRow[]>([]);
    loading = signal(true);
    unbanningId = signal<string | null>(null);
    showBanDialog = signal(false);
    banReason = signal('');
    banning = signal(false);
    filter = signal('');
    confirmUnbanRow = signal<BanRow | null>(null);
    showUnbanDialog = signal(false);

    // ── Ban dialog ───────────────────────────────────────────────────────────
    banMode = signal<BanMode>('member');
    banSearch = signal('');
    banCandidates = signal<GuildMemberDto[]>([]);
    banSearchLoading = signal(false);
    /** The member picked out of the search, shown back to the moderator before Ban is pressable. */
    banTarget = signal<GuildMemberDto | null>(null);
    /** Raw-id path only. Never the default: nobody knows anyone's UUID. */
    banUserId = signal('');

    /** The list can run long on a busy server, so it filters on name, reason and ID. */
    filteredBans = computed(() => {
        const q = this.filter().trim().toLowerCase();
        if (!q) return this.bans();
        return this.bans().filter(row =>
            this.displayName(row).toLowerCase().includes(q)
            || (row.ban.reason ?? '').toLowerCase().includes(q)
            || row.ban.userId.toLowerCase().includes(q)
        );
    });

    /** Whichever of the two paths is active resolves to the one id that gets banned. */
    protected banTargetUserId = computed(() =>
        this.banMode() === 'id' ? this.banUserId().trim() : this.banTarget()?.userId ?? ''
    );

    protected canBan = computed(() => this.banTargetUserId().length > 0);

    /**
     * At most this many profile lookups in flight while the ban list resolves its names.
     *
     * <p>Every row used to fire its own request the instant the list landed, so a server with a few
     * hundred bans opened a few hundred parallel GETs and tripped the rate limiter.</p>
     */
    private static readonly PROFILE_CONCURRENCY = 5;

    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private brokenImages = inject(BrokenImageService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private destroyRef = inject(DestroyRef);

    private profileFetches?: Subscription;
    private banSearchTimer?: ReturnType<typeof setTimeout>;

    constructor() {
        this.destroyRef.onDestroy(() => {
            this.profileFetches?.unsubscribe();
            clearTimeout(this.banSearchTimer);
        });
    }

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getBans(this.guild().id).subscribe({
            next: bans => {
                // Rows the profile cache already knows about paint with a name straight away and
                // never reach the wire at all.
                this.bans.set(bans.map(ban => ({
                    ban,
                    profile: this.profileService.getCachedByUserId(ban.userId) ?? null,
                })));
                this.loading.set(false);
                this.resolveMissingProfiles(bans);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.BANS.LOAD_ERROR'), err);
            },
        });
    }

    /** A profile that has not landed yet gets a neutral name, never a slice of its raw UUID. */
    displayName(row: BanRow): string {
        return row.profile?.userName ?? this.translate.instant('GUILD_SETTINGS.BANS.UNKNOWN_MEMBER');
    }

    /** Drives the avatar fallback: an initial only means something once we have a real name. */
    hasProfile(row: BanRow): boolean {
        return !!row.profile?.userName;
    }

    // The API sends an avatarUrl for every profile, uploaded or not, so a URL that has already
    // failed is the only signal that this user has no avatar. See BrokenImageService.
    avatarUrl(row: BanRow): string | undefined {
        return this.profileAvatar(row.profile);
    }

    onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    // ── Ban dialog ───────────────────────────────────────────────────────────

    openBanDialog(): void {
        this.banMode.set('member');
        this.banTarget.set(null);
        this.banUserId.set('');
        this.banSearch.set('');
        this.banCandidates.set([]);
        this.banReason.set('');
        this.showBanDialog.set(true);
        this.fetchBanCandidates('');
    }

    setBanMode(mode: BanMode): void {
        this.banMode.set(mode);
        // Clearing the path being left is what keeps a hidden, stale target from being the thing
        // that actually gets banned.
        if (mode === 'id') {
            this.banTarget.set(null);
            return;
        }
        this.banUserId.set('');
        if (this.banCandidates().length === 0) this.fetchBanCandidates(this.banSearch().trim());
    }

    onBanSearchChange(query: string): void {
        this.banSearch.set(query);
        clearTimeout(this.banSearchTimer);
        this.banSearchTimer = setTimeout(() => this.fetchBanCandidates(query.trim()), 300);
    }

    selectBanTarget(member: GuildMemberDto): void {
        this.banTarget.set(member);
    }

    clearBanTarget(): void {
        this.banTarget.set(null);
    }

    memberName(member: GuildMemberDto): string {
        return member.profile?.userName
            ?? member.nickname
            ?? this.translate.instant('GUILD_SETTINGS.BANS.UNKNOWN_MEMBER');
    }

    memberAvatarUrl(member: GuildMemberDto): string | undefined {
        return this.profileAvatar(member.profile);
    }

    submitBan(): void {
        const userId = this.banTargetUserId();
        if (!userId || this.banning()) return;
        this.banning.set(true);
        this.guildService.banMember(this.guild().id, {userId, reason: this.banReason().trim() || undefined}).subscribe({
            next: () => {
                this.showBanDialog.set(false);
                this.banning.set(false);
                this.banTarget.set(null);
                this.banUserId.set('');
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.BANS.BAN_SUCCESS'));
                this.load();
            },
            error: err => {
                this.banning.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.BANS.BAN_ERROR'), err);
            },
        });
    }

    // ── Unban ────────────────────────────────────────────────────────────────

    openUnbanDialog(row: BanRow): void {
        this.confirmUnbanRow.set(row);
        this.showUnbanDialog.set(true);
    }

    closeUnbanDialog(): void {
        this.confirmUnbanRow.set(null);
        this.showUnbanDialog.set(false);
    }

    unban(row: BanRow): void {
        if (this.unbanningId()) return;
        this.unbanningId.set(row.ban.id);
        this.guildService.unbanMember(this.guild().id, row.ban.userId).subscribe({
            next: () => {
                this.bans.update(list => list.filter(r => r.ban.id !== row.ban.id));
                this.unbanningId.set(null);
                this.closeUnbanDialog();
            },
            error: err => {
                this.unbanningId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.BANS.UNBAN_ERROR'), err);
            },
        });
    }

    private profileAvatar(profile: ProfileDto | null | undefined): string | undefined {
        const url = profile?.avatarUrl;
        return this.brokenImages.isBroken(url) ? undefined : url;
    }

    /**
     * Fills in the names the cache did not already have, a few requests at a time.
     *
     * <p>A reload while a previous queue is still draining cancels that queue first, so repeated
     * bans cannot stack one fan-out on top of another.</p>
     */
    private resolveMissingProfiles(bans: BanDto[]): void {
        this.profileFetches?.unsubscribe();
        const missing = bans.filter(ban => !this.profileService.getCachedByUserId(ban.userId));
        if (missing.length === 0) return;

        this.profileFetches = from(missing).pipe(
            mergeMap(
                ban => this.profileService.fetchByUserId(ban.userId).pipe(
                    map(profile => ({ban, profile})),
                    // One dead or deleted user id must not stop the rest of the queue.
                    catchError(() => EMPTY),
                ),
                BansSettingsComponent.PROFILE_CONCURRENCY,
            ),
        ).subscribe(({ban, profile}) => {
            // Matched back by ban id, not list index: an unban landing mid-flight used
            // to shift the array and staple the arriving profile onto the wrong row.
            this.bans.update(list => list.map(r => r.ban.id === ban.id ? {...r, profile} : r));
        });
    }

    /** Someone already on the ban list is not a candidate to ban again. */
    private fetchBanCandidates(query: string): void {
        this.banSearchLoading.set(true);
        const obs = query
            ? this.guildService.searchMembers(this.guild().id, query)
            : this.guildService.getMembers(this.guild().id, 0, 30);
        obs.subscribe({
            next: members => {
                const banned = new Set(this.bans().map(row => row.ban.userId));
                this.banCandidates.set(members.filter(m => !banned.has(m.userId)));
                this.banSearchLoading.set(false);
            },
            error: () => this.banSearchLoading.set(false),
        });
    }
}
