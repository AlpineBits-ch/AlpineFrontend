import {BillStatus} from './bill.dto';
import {ChoreOccurrence} from './chore.dto';
import {HomeStatusDto} from './home-status.dto';
import {ListItem} from './list.dto';
import {AssetStatus} from './maintenance.dto';
import {MealSlot} from './meal.dto';
import {PantryItem} from './pantry.dto';

/**
 * `GET /guilds/{guildId}/home` - the whole house in one request.
 *
 * <p>What a home tab, a lock-screen widget or a watch complication needs, assembled server-side
 * instead of by six client calls that would each have to be permission-checked, feature-gated and
 * failed independently.</p>
 *
 * <p><b>A null section means render nothing.</b> It covers both "the module is off" and "you can
 * see no channel of that type", and the two are deliberately not distinguished - telling somebody
 * there is a ledger they are not allowed to see is a disclosure for no gain. So nothing in this
 * client may draw an empty-state, a lock or a "no access" line off a null section; it draws
 * nothing at all, and the difference between the two is not knowable from here.</p>
 *
 * <p><b>Everything is capped.</b> This is a glance. The per-module endpoints remain the way to read
 * a whole board, and anything here that looks like a list is a preview of one.</p>
 */
export interface HouseholdDigest {
    guildId: string;
    chores?: HouseholdDigestChores | null;
    /** One entry per list channel the caller can see. */
    lists?: HouseholdDigestList[] | null;
    pantry?: HouseholdDigestPantry | null;
    /** One entry per ledger channel the caller can see, each in its own currency. */
    ledger?: HouseholdDigestLedger[] | null;
    decisions?: HouseholdDigestDecisions | null;
    homeStatus?: HomeStatusDto[] | null;
    /** What the house owes and when, from the ledger channels the caller can see. */
    bills?: HouseholdDigestBills | null;
    meals?: HouseholdDigestMeals | null;
    maintenance?: HouseholdDigestMaintenance | null;
    /**
     * Who is away right now, and until when.
     *
     * <p>Beside {@link homeStatus} and deliberately not folded into it - see
     * {@link import('./absence.dto').Absence}. One is a decaying assertion about this minute, the
     * other a dated plan the rota reads, and merging them would give a fortnight in Lisbon an
     * expiry it does not have.</p>
     */
    away?: HouseholdDigestAbsence[] | null;
}

export interface HouseholdDigestChores {
    /** Due within a day or already past due, and mine. At most ten. */
    mine: ChoreOccurrence[];
    mineOverdueCount: number;
    /** <b>Everyone's</b>, not just the caller's - "the house is behind" is the useful sentence. */
    houseOverdueCount: number;
}

export interface HouseholdDigestList {
    channelId: string;
    channelName: string;
    /** Unchecked items in the whole list, of which {@link preview} shows the first few. */
    openCount: number;
    preview: ListItem[];
}

export interface HouseholdDigestPantry {
    /** Across every pantry the caller can see, each judged by its own `expiryWarningDays`. */
    expiringCount: number;
    soonest: PantryItem[];
}

export interface HouseholdDigestLedger {
    channelId: string;
    channelName: string;
    /** ISO-4217, one per ledger channel. Never add two of these together. */
    currency: string;
    /** <b>The caller's own position only.</b> Positive means the house owes them. */
    myNetMinor: number;
}

export interface HouseholdDigestDecisions {
    openCount: number;
    awaitingMyVote: HouseholdDigestDecisionRef[];
}

export interface HouseholdDigestDecisionRef {
    id: string;
    channelId: string;
    title: string;
    closesAt?: string | null;
}

export interface HouseholdDigestBills {
    /**
     * Pending bills due inside the next fortnight, soonest first, with anything already late at the
     * top. Overdue rows stay <b>in</b> the list rather than being counted away from it: a bill that
     * is late is still a bill that is due, and hiding it would leave the most urgent row off.
     */
    dueSoon: HouseholdDigestBill[];
    overdueCount: number;
    /**
     * Varying bills that came due with nobody having said what they cost. Counted apart from
     * {@link overdueCount} because the action is different - one needs money moved, the other needs
     * somebody to open the post.
     */
    needsAmountCount: number;
}

export interface HouseholdDigestBill {
    id: string;
    channelId: string;
    description: string;
    dueAt: string;
    /** Null while the amount is still unknown. **Never rendered as zero.** */
    amountMinor?: number | null;
    currency: string;
    /**
     * What this period will cost the caller. Null when there is no total to divide yet, and also
     * when the template's split no longer resolves - a wrong share on a glance is worse than a
     * missing one, because it is the number somebody transfers.
     */
    myShareMinor?: number | null;
    status: BillStatus;
}

export interface HouseholdDigestMeals {
    /** What is planned for today, in board order across every meals channel the caller can see. */
    today: HouseholdDigestMeal[];
    /** Computed over the whole day rather than the capped {@link today} list. */
    imCookingToday: boolean;
}

export interface HouseholdDigestMeal {
    id: string;
    channelId: string;
    slot: MealSlot;
    /** The recipe's title or the entry's free text, flattened - a glance renders one line either way. */
    title: string;
    cookUserId?: string | null;
}

export interface HouseholdDigestMaintenance {
    brokenCount: number;
    serviceOverdueCount: number;
    /** Warranties lapsing soon. Already-lapsed ones are not counted - nothing left to do. */
    warrantyExpiringCount: number;
    /** The few worth showing, most urgent first. */
    attention: HouseholdDigestAsset[];
}

export interface HouseholdDigestAsset {
    id: string;
    channelId: string;
    name: string;
    status: AssetStatus;
    /**
     * The single most urgent of the attention board's tokens.
     *
     * <p>One where the full board carries all of them, and that is the difference between the two
     * surfaces rather than an omission: the board has room to say a machine is both broken and out
     * of warranty, a glance line has room for the word that decides whether anybody gets up.</p>
     */
    reason: string;
}

export interface HouseholdDigestAbsence {
    userId: string;
    startAt: string;
    /** Exclusive. */
    endAt: string;
    note?: string | null;
}

/**
 * A digest plus the `ETag` it came with.
 *
 * <p>The conditional request saves the transfer, not the server work - there is no single timestamp
 * that moves when any of six modules changes, so the digest is assembled either way. Which is why
 * this client sends `If-None-Match` on a widget-style refresh and not on a user-initiated open: the
 * saving is bandwidth, and re-rendering identical rows is the thing worth avoiding.</p>
 */
export interface HouseholdDigestResponse {
    /** Null when {@link notModified} - the caller's existing copy is still current. */
    digest: HouseholdDigest | null;
    /**
     * Null when the server sent none, or when it sent one the browser will not let this client read
     * - a cross-origin `ETag` needs `Access-Control-Expose-Headers`. Either way the next fetch just
     * goes out unconditional, which costs a transfer and is never wrong.
     */
    etag: string | null;
    /** The server answered `304`: nothing changed since the tag that was sent with the request. */
    notModified: boolean;
}

/**
 * Whether a digest has anything at all to draw.
 *
 * <p>Distinct from "every section is null". A house with a shopping list that is empty, no chores
 * due and nobody's status set has sections but no rows, and that is a real state worth saying
 * something friendly about rather than rendering six empty panels.</p>
 */
export function isDigestEmpty(digest: HouseholdDigest | null | undefined): boolean {
    if (!digest) return true;
    return !digest.chores?.mine.length
        && !digest.chores?.houseOverdueCount
        && !digest.lists?.some(l => l.openCount > 0)
        && !digest.pantry?.expiringCount
        && !digest.ledger?.some(l => l.myNetMinor !== 0)
        && !digest.decisions?.openCount
        && !digest.homeStatus?.length
        && !digest.bills?.dueSoon.length
        && !digest.meals?.today.length
        // The counts and not `attention.length`: a house can have a broken machine the capped
        // attention list did not have room for, and "all clear" would then be a lie.
        && !digest.maintenance?.brokenCount
        && !digest.maintenance?.serviceOverdueCount
        && !digest.maintenance?.warrantyExpiringCount
        && !digest.away?.length;
}
