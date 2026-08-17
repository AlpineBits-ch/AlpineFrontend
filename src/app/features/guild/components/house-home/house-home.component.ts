import {Component, computed, effect, inject, input, untracked} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {ChoreOccurrence} from '../../../../dtos/response/chore.dto';
import {HomeStatusDto} from '../../../../dtos/response/home-status.dto';
import {
    HouseholdDigestAbsence,
    HouseholdDigestAsset,
    HouseholdDigestBill,
    HouseholdDigestDecisionRef,
    HouseholdDigestLedger,
    HouseholdDigestList,
    HouseholdDigestMeal,
    isDigestEmpty,
} from '../../../../dtos/response/household-digest.dto';
import {PantryItem} from '../../../../dtos/response/pantry.dto';
import {formatMinor} from '../../../../helpers/money.helper';
import {GuildService} from '../../../../services/guild.service';
import {HouseholdDigestService} from '../../../../services/household-digest.service';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {homeStatusMeta} from '../../home-status-meta';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {AwayBoardComponent} from '../away-board/away-board.component';

/** A ledger row, with the sign already resolved into "they owe you" / "you owe". */
interface LedgerRow {
    entry: HouseholdDigestLedger;
    amount: string;
    /** `owed` = the house owes the caller. Positive `myNetMinor`. */
    direction: 'owed' | 'owes' | 'settled';
}

/** Both amounts are nullable and stay that way: an amount nobody has named yet is not zero, and an unresolved share is worse wrong than missing, since it is the number somebody transfers. */
interface BillRow {
    bill: HouseholdDigestBill;
    amount: string | null;
    myShare: string | null;
    dueLabel: string;
}

interface AwayRow {
    absence: HouseholdDigestAbsence;
    until: string;
}

/** Read-only: every row is a way into the board that owns it, nothing is done from here. A null section renders nothing, not an empty state or lock, since the server doesn't distinguish "module off" from "no channel you can see". */
@Component({
    selector: 'app-house-home',
    imports: [Button, TranslateModule, AwayBoardComponent],
    templateUrl: './house-home.component.html',
})
export class HouseHomeComponent {
    readonly guildId = input.required<string>();

    protected navService = inject(NavigationService);
    private guildService = inject(GuildService);
    private digestService = inject(HouseholdDigestService);
    private profiles = inject(ProfileService);

    protected readonly guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.guildId()) ?? null);

    protected readonly state = computed(() => this.digestService.stateFor(this.guildId()));
    protected readonly digest = computed(() => this.state().digest);

    /** Only while nothing has ever landed: a refresh must not blank the panel it is refreshing. */
    protected readonly showSpinner = computed(() => this.state().loading && !this.digest());

    /** Everything arrived and there is nothing to do; distinct from every section being null, since an empty list is still a section with no rows. */
    protected readonly allClear = computed(() =>
        !!this.digest() && !this.state().loading && isDigestEmpty(this.digest()));

    /** What the sections read from: the digest, or nothing once {@link allClear}, so the all-clear line replaces the cards instead of sitting under empty ones. */
    private readonly sections = computed(() => this.allClear() ? null : this.digest());

    protected readonly chores = computed(() => this.sections()?.chores ?? null);
    protected readonly lists = computed(() => this.sections()?.lists ?? null);
    protected readonly pantry = computed(() => this.sections()?.pantry ?? null);
    protected readonly decisions = computed(() => this.sections()?.decisions ?? null);
    protected readonly homeStatus = computed(() => this.sections()?.homeStatus ?? null);
    protected readonly bills = computed(() => this.sections()?.bills ?? null);
    protected readonly meals = computed(() => this.sections()?.meals ?? null);
    protected readonly maintenance = computed(() => this.sections()?.maintenance ?? null);
    /** Who is away; its own section rather than merged into {@link homeStatus}: one is a decaying assertion about this minute, the other a dated plan the rota reads. See `absence.dto.ts`. */
    protected readonly away = computed(() => this.sections()?.away ?? null);

    /** Whether the editable away board is drawn (and the digest's read-only away summary skipped); reads `features` directly rather than inferring from a possibly stale digest payload. */
    protected readonly awayBoardVisible = computed(() =>
        guildHasFeature(this.guild(), GuildFeature.Presence));

    protected readonly billRows = computed<BillRow[]>(() => (this.bills()?.dueSoon ?? []).map(bill => ({
        bill,
        // Null while the amount is unknown, drawn as words rather than 0.00, since a zero here would claim this month costs nothing.
        amount: bill.amountMinor == null ? null : formatMinor(bill.amountMinor, bill.currency),
        myShare: bill.myShareMinor == null ? null : formatMinor(bill.myShareMinor, bill.currency),
        dueLabel: this.dayLabel(bill.dueAt),
    })));

    protected readonly awayRows = computed<AwayRow[]>(() => (this.away() ?? []).map(absence => ({
        absence,
        // Drawn as the last day somebody is away, not the exclusive boundary the row carries: "until the 28th" would be a day too many.
        until: this.dayLabel(new Date(new Date(absence.endAt).getTime() - 1).toISOString()),
    })));

    protected readonly ledgerRows = computed<LedgerRow[]>(() =>
        (this.sections()?.ledger ?? []).map(entry => ({
            entry,
            // Never summed across rows: one ledger channel is one currency, and adding two together would produce a number in no currency at all.
            amount: formatMinor(Math.abs(entry.myNetMinor), entry.currency),
            direction: entry.myNetMinor > 0 ? 'owed' : entry.myNetMinor < 0 ? 'owes' : 'settled',
        })));

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => void this.digestService.ensureLoaded(guildId));
        });

        // The digest names people by id (assignees, whoever is home); the profile cache is a signal, so filling it re-renders the rows waiting on it.
        effect(() => {
            const ids = [
                ...(this.chores()?.mine ?? []).map(o => o.assignedUserId),
                ...(this.homeStatus() ?? []).map(s => s.userId),
            ];
            const missing = ids.filter(id => !this.profiles.getCachedByUserId(id));
            untracked(() => missing.forEach(id => this.profiles.resolveByUserId(id)));
        });
    }

    protected refresh(): void {
        void this.digestService.refresh(this.guildId());
    }

    /** Opens the board a row belongs to; the channel is resolved from the loaded guild, not trusted from the digest, since silently doing nothing beats navigating to a channel this client can't draw. */
    protected openChannel(channelId: string): void {
        const channel = this.channelById(channelId);
        if (channel) this.navService.openChannel(channel);
    }

    protected channelName(channelId: string): string {
        return this.channelById(channelId)?.name ?? '';
    }

    protected displayName(userId: string): string {
        return this.profiles.getCachedByUserId(userId)?.userName ?? userId.slice(0, 8) + '…';
    }

    protected statusMeta(status: HomeStatusDto) {
        return homeStatusMeta(status.kind);
    }

    /** "18:30" today, "Thu 18:30" beyond it. Same shape the chore board and the status board use. */
    protected timeLabel(iso: string | null | undefined): string {
        if (!iso) return '';
        const at = new Date(iso);
        if (Number.isNaN(at.getTime())) return '';
        const time = at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        return at.toDateString() === new Date().toDateString()
            ? time
            : `${at.toLocaleDateString([], {weekday: 'short'})} ${time}`;
    }

    /** `14 Aug`. Bills and absences are dated rather than clocked: the day is the useful part. */
    protected dayLabel(iso: string): string {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'}).format(date);
    }

    /** The one word that decides whether anybody gets up; the digest sends a single token where the attention board carries all of them, and an unrecognised token still renders rather than being dropped. */
    protected assetReasonKey(asset: HouseholdDigestAsset): string {
        return `MAINTENANCE.REASON.${asset.reason.toUpperCase()}`;
    }

    protected mealSlotKey(meal: HouseholdDigestMeal): string {
        return `MEALS.SLOT_${String(meal.slot).toUpperCase()}`;
    }

    protected trackOccurrence = (_: number, o: ChoreOccurrence) => o.id;
    protected trackList = (_: number, l: HouseholdDigestList) => l.channelId;
    protected trackPantryItem = (_: number, i: PantryItem) => i.id;
    protected trackDecision = (_: number, d: HouseholdDigestDecisionRef) => d.id;
    protected trackStatus = (_: number, s: HomeStatusDto) => s.userId;
    protected trackBill = (_: number, r: BillRow) => r.bill.id;
    protected trackMeal = (_: number, m: HouseholdDigestMeal) => m.id;
    protected trackAsset = (_: number, a: HouseholdDigestAsset) => a.id;
    protected trackAway = (_: number, r: AwayRow) => r.absence.userId + r.absence.startAt;

    private channelById(channelId: string): ChannelDto | undefined {
        return this.guild()?.channels.find(c => c.id === channelId);
    }
}
