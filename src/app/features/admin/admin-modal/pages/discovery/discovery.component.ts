import {ChangeDetectionStrategy, Component, computed, inject, OnInit, signal} from '@angular/core';
import {DatePipe, NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {
    AdminDiscoveryService,
    AdminListingRowDto,
    CreateDiscoveryBanDto,
    DiscoveryBanDto,
} from '../../../../../services/admin-discovery.service';
import {ListingState} from '../../../../../dtos/response/discovery.dto';
import {ToastService} from '../../../../../services/toast.service';

/** Reused from the listing editor: same enum, same wording. */
const STATE_KEYS: Record<ListingState, string> = {
    Draft: 'DISCOVERY.LISTING.STATE.DRAFT',
    Published: 'DISCOVERY.LISTING.STATE.PUBLISHED',
    Suspended: 'DISCOVERY.LISTING.STATE.SUSPENDED',
    Unlisted: 'DISCOVERY.LISTING.STATE.UNLISTED',
};

type BanStatus = 'active' | 'expired' | 'lifted';

const BAN_STATUS_KEYS: Record<BanStatus, string> = {
    active: 'ADMIN.DISCOVERY.BANS.STATUS.ACTIVE',
    expired: 'ADMIN.DISCOVERY.BANS.STATUS.EXPIRED',
    lifted: 'ADMIN.DISCOVERY.BANS.STATUS.LIFTED',
};

/** Every literal key the two lookup tables above can produce, for `i18n-keys.spec.ts`. */
export const ADMIN_DISCOVERY_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(STATE_KEYS),
    ...Object.values(BAN_STATUS_KEYS),
];

function banStatus(ban: DiscoveryBanDto, now: number): BanStatus {
    if (ban.liftedAt) return 'lifted';
    if (ban.expiresAt && new Date(ban.expiresAt).getTime() <= now) return 'expired';
    return 'active';
}

/** A `yyyy-MM-dd` date picker value to the UTC instant the chosen day ends, so the ban covers the whole day. */
function endOfPickedDayUtc(dateOnly: string): string {
    const [year, month, day] = dateOnly.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
}

/**
 * Bans a guild out of the discovery directory. Search finds the guild, the ban list shows who is
 * banned and why, and lifting a ban never republishes the guild's listing - that stays the owner's
 * own action.
 */
@Component({
    selector: 'app-admin-discovery',
    imports: [FormsModule, NgClass, Button, InputText, Textarea, ToggleSwitch, TranslateModule, DatePipe],
    templateUrl: './discovery.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminDiscoveryComponent implements OnInit {
    private readonly svc = inject(AdminDiscoveryService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly query = signal('');
    protected readonly listings = signal<AdminListingRowDto[]>([]);
    protected readonly listingsCursor = signal<string | null>(null);
    protected readonly listingsLoading = signal(false);
    protected readonly listingsError = signal(false);
    protected readonly searched = signal(false);

    protected readonly includeLifted = signal(false);
    protected readonly bans = signal<DiscoveryBanDto[]>([]);
    protected readonly bansCursor = signal<string | null>(null);
    protected readonly bansLoading = signal(false);
    protected readonly bansError = signal(false);
    protected readonly liftingGuildId = signal<string | null>(null);

    protected readonly formOpen = signal(false);
    protected readonly formGuildId = signal('');
    protected readonly formGuildName = signal<string | null>(null);
    protected readonly formGuildIdLocked = signal(false);
    protected readonly formReason = signal('');
    protected readonly formStaffNote = signal('');
    protected readonly formExpiresAt = signal('');
    protected readonly formSubmitting = signal(false);
    protected readonly formError = signal<string | null>(null);

    protected readonly formValid = computed(
        () => this.formGuildId().trim().length > 0 && this.formReason().trim().length > 0,
    );

    protected readonly stateKeys = STATE_KEYS;

    ngOnInit(): void {
        this.loadBans();
    }

    // ── Search ───────────────────────────────────────────────────────────────

    protected search(): void {
        this.listingsLoading.set(true);
        this.listingsError.set(false);
        this.svc.searchListings(this.query().trim() || undefined).subscribe({
            next: result => {
                this.listings.set(result.rows);
                this.listingsCursor.set(result.nextCursor);
                this.listingsLoading.set(false);
                this.searched.set(true);
            },
            error: () => {
                this.listingsError.set(true);
                this.listingsLoading.set(false);
                this.searched.set(true);
            },
        });
    }

    protected loadMoreListings(): void {
        const cursor = this.listingsCursor();
        if (!cursor || this.listingsLoading()) return;
        this.listingsLoading.set(true);
        this.svc.searchListings(this.query().trim() || undefined, cursor).subscribe({
            next: result => {
                this.listings.update(rows => [...rows, ...result.rows]);
                this.listingsCursor.set(result.nextCursor);
                this.listingsLoading.set(false);
            },
            error: () => {
                this.listingsError.set(true);
                this.listingsLoading.set(false);
            },
        });
    }

    // ── Bans ─────────────────────────────────────────────────────────────────

    protected loadBans(): void {
        this.bansLoading.set(true);
        this.bansError.set(false);
        this.svc.listBans(this.includeLifted()).subscribe({
            next: result => {
                this.bans.set(result.bans);
                this.bansCursor.set(result.nextCursor);
                this.bansLoading.set(false);
            },
            error: () => {
                this.bansError.set(true);
                this.bansLoading.set(false);
            },
        });
    }

    protected loadMoreBans(): void {
        const cursor = this.bansCursor();
        if (!cursor || this.bansLoading()) return;
        this.bansLoading.set(true);
        this.svc.listBans(this.includeLifted(), cursor).subscribe({
            next: result => {
                this.bans.update(rows => [...rows, ...result.bans]);
                this.bansCursor.set(result.nextCursor);
                this.bansLoading.set(false);
            },
            error: () => {
                this.bansError.set(true);
                this.bansLoading.set(false);
            },
        });
    }

    protected setIncludeLifted(value: boolean): void {
        this.includeLifted.set(value);
        this.loadBans();
    }

    protected status(ban: DiscoveryBanDto): BanStatus {
        return banStatus(ban, Date.now());
    }

    protected statusKey(ban: DiscoveryBanDto): string {
        return BAN_STATUS_KEYS[this.status(ban)];
    }

    protected liftBan(ban: DiscoveryBanDto): void {
        if (this.liftingGuildId()) return;
        this.liftingGuildId.set(ban.guildId);
        this.svc.liftBan(ban.guildId).subscribe({
            next: lifted => {
                this.liftingGuildId.set(null);
                if (this.includeLifted()) {
                    this.bans.update(rows => rows.map(b => (b.guildId === lifted.guildId ? lifted : b)));
                } else {
                    this.bans.update(rows => rows.filter(b => b.guildId !== lifted.guildId));
                }
                this.toast.success(this.translate.instant('ADMIN.DISCOVERY.BANS.LIFTED_SUCCESS'));
            },
            error: () => {
                this.liftingGuildId.set(null);
                this.toast.error(this.translate.instant('ADMIN.DISCOVERY.BANS.LIFT_ERROR'));
            },
        });
    }

    // ── Ban form ─────────────────────────────────────────────────────────────

    protected openBanForm(row?: AdminListingRowDto): void {
        this.formGuildId.set(row?.guildId ?? '');
        this.formGuildName.set(row?.guildName ?? null);
        this.formGuildIdLocked.set(!!row);
        this.formReason.set('');
        this.formStaffNote.set('');
        this.formExpiresAt.set('');
        this.formError.set(null);
        this.formOpen.set(true);
    }

    protected closeBanForm(): void {
        this.formOpen.set(false);
    }

    protected submitBan(): void {
        if (!this.formValid() || this.formSubmitting()) return;

        const dto: CreateDiscoveryBanDto = {
            guildId: this.formGuildId().trim(),
            reason: this.formReason().trim(),
        };
        const staffNote = this.formStaffNote().trim();
        if (staffNote) dto.staffNote = staffNote;
        const expiresAt = this.formExpiresAt();
        if (expiresAt) dto.expiresAt = endOfPickedDayUtc(expiresAt);

        this.formSubmitting.set(true);
        this.formError.set(null);
        this.svc.createBan(dto).subscribe({
            next: ban => {
                this.formSubmitting.set(false);
                this.formOpen.set(false);
                this.bans.update(rows => [ban, ...rows]);
                this.toast.success(this.translate.instant('ADMIN.DISCOVERY.FORM.SUCCESS'));
            },
            error: () => {
                this.formSubmitting.set(false);
                const message = this.translate.instant('ADMIN.DISCOVERY.FORM.ERROR');
                this.formError.set(message);
                this.toast.error(message);
            },
        });
    }
}
