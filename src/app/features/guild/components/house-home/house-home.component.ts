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

/**
 * One upcoming bill, formatted.
 *
 * <p>Both amounts are nullable and stay that way: an amount nobody has named yet is not zero, and a
 * share the split could not resolve is worse wrong than missing - it is the number somebody
 * transfers.</p>
 */
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

/**
 * The house at a glance - `GET /guilds/{id}/home` in one panel.
 *
 * <p>One request instead of six, and one screen instead of opening six channels to find out
 * whether anything needs doing. It is deliberately <b>read-only</b>: every row is a way into the
 * board that owns it, and no chore is completed, item ticked or vote cast from here. A glance that
 * also mutates would need each module's permission resolution, which is per channel, and would put
 * the two most destructive gestures in the house one mis-tap apart.</p>
 *
 * <p><b>A null section renders nothing at all</b> - not an empty state, not a lock. Null covers
 * both "the module is off" and "you can see no channel of that type", the server does not
 * distinguish them, and inventing a distinction here would tell an outsider there is a ledger they
 * are not allowed to see.</p>
 */
@Component({
    selector: 'app-house-home',
    imports: [Button, TranslateModule, AwayBoardComponent],
    templateUrl: './house-home.component.html',
})
export class HouseHomeComponent {
    guildId = input.required<string>();

    protected navService = inject(NavigationService);
    private guildService = inject(GuildService);
    private digestService = inject(HouseholdDigestService);
    private profiles = inject(ProfileService);

    protected guild = computed(() =>
        this.guildService.guilds().find(g => g.id === this.guildId()) ?? null);

    protected state = computed(() => this.digestService.stateFor(this.guildId()));
    protected digest = computed(() => this.state().digest);

    /** Only while nothing has ever landed: a refresh must not blank the panel it is refreshing. */
    protected showSpinner = computed(() => this.state().loading && !this.digest());

    /**
     * Everything arrived and there is nothing to do.
     *
     * <p>Distinct from every section being null - a house with an empty shopping list and nobody
     * behind on chores has sections and no rows, and that deserves a sentence rather than six
     * empty panels.</p>
     */
    protected allClear = computed(() =>
        !!this.digest() && !this.state().loading && isDigestEmpty(this.digest()));

    /**
     * What the sections read from - the digest, or nothing once {@link allClear}.
     *
     * <p>The all-clear line replaces the cards rather than sitting under them: a column of panels
     * each saying nothing is due is a worse answer than one sentence saying so.</p>
     */
    private sections = computed(() => this.allClear() ? null : this.digest());

    protected chores = computed(() => this.sections()?.chores ?? null);
    protected lists = computed(() => this.sections()?.lists ?? null);
    protected pantry = computed(() => this.sections()?.pantry ?? null);
    protected decisions = computed(() => this.sections()?.decisions ?? null);
    protected homeStatus = computed(() => this.sections()?.homeStatus ?? null);
    protected bills = computed(() => this.sections()?.bills ?? null);
    protected meals = computed(() => this.sections()?.meals ?? null);
    protected maintenance = computed(() => this.sections()?.maintenance ?? null);
    /**
     * Who is away. Its own section rather than merged into {@link homeStatus}: one is a decaying
     * assertion about this minute, the other a dated plan the rota reads. See `absence.dto.ts`.
     */
    protected away = computed(() => this.sections()?.away ?? null);

    /**
     * Whether the editable away board is drawn, and therefore whether the digest's read-only
     * summary of the same absences is skipped.
     *
     * <p>Only when the house has the Presence module. The digest's `away` section being non-null
     * already implies it, but the digest can be stale and the board is the thing that has to be
     * reachable to declare an absence at all - so this reads `features` directly rather than
     * inferring the module from a payload.</p>
     */
    protected awayBoardVisible = computed(() =>
        guildHasFeature(this.guild(), GuildFeature.Presence));

    protected billRows = computed<BillRow[]>(() => (this.bills()?.dueSoon ?? []).map(bill => ({
        bill,
        // Null while the amount is unknown, and drawn as words rather than as 0.00 - a zero here
        // would be a claim that this month costs nothing.
        amount: bill.amountMinor == null ? null : formatMinor(bill.amountMinor, bill.currency),
        myShare: bill.myShareMinor == null ? null : formatMinor(bill.myShareMinor, bill.currency),
        dueLabel: this.dayLabel(bill.dueAt),
    })));

    protected awayRows = computed<AwayRow[]>(() => (this.away() ?? []).map(absence => ({
        absence,
        // Drawn as the last day somebody is away rather than as the exclusive boundary the row
        // carries: "until the 28th" for an absence ending at midnight on the 28th is a day too many.
        until: this.dayLabel(new Date(new Date(absence.endAt).getTime() - 1).toISOString()),
    })));

    protected ledgerRows = computed<LedgerRow[]>(() =>
        (this.sections()?.ledger ?? []).map(entry => ({
            entry,
            // Never summed across rows: one ledger channel is one currency, and adding two of them
            // together would produce a number in no currency at all.
            amount: formatMinor(Math.abs(entry.myNetMinor), entry.currency),
            direction: entry.myNetMinor > 0 ? 'owed' : entry.myNetMinor < 0 ? 'owes' : 'settled',
        })));

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => void this.digestService.ensureLoaded(guildId));
        });

        // The digest names people by id - assignees, and whoever is home. The profile cache is a
        // signal, so filling it re-renders the rows that were waiting on it.
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

    /**
     * Opens the board a row belongs to.
     *
     * <p>The channel is resolved out of the loaded guild rather than trusted from the digest: a
     * channel the sidebar does not have is one this client cannot draw, and silently doing nothing
     * beats navigating to a view with no channel behind it.</p>
     */
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

    /** `14 Aug`. Bills and absences are dated rather than clocked - the day is the useful part. */
    protected dayLabel(iso: string): string {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short'}).format(date);
    }

    /**
     * The one word that decides whether anybody gets up.
     *
     * <p>The digest sends a single token where the attention board carries all of them, and that is
     * the difference between the two surfaces rather than an omission - a glance line has room for
     * one. An unrecognised token still names something real, so it is rendered rather than dropped.
     * </p>
     */
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
