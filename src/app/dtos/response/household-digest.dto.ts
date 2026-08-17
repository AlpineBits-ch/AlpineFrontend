import {BillStatus} from './bill.dto';
import {ChoreOccurrence} from './chore.dto';
import {HomeStatusDto} from './home-status.dto';
import {ListItem} from './list.dto';
import {AssetStatus} from './maintenance.dto';
import {MealSlot} from './meal.dto';
import {PantryItem} from './pantry.dto';

/**
 * `GET /guilds/{guildId}/home`, the whole house in one request. A null section means render
 * nothing, never an empty-state or a lock. Every list here is capped and is a preview.
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
    /** Who is away right now, and until when. Separate from {@link homeStatus}; never merge the two. */
    away?: HouseholdDigestAbsence[] | null;
}

export interface HouseholdDigestChores {
    /** Due within a day or already past due, and mine. At most ten. */
    mine: ChoreOccurrence[];
    mineOverdueCount: number;
    /** Everyone's, not just the caller's. */
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
    /** The caller's own position only. Positive means the house owes them. */
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
    /** Pending bills due inside the next fortnight, soonest first. Overdue rows stay in the list. */
    dueSoon: HouseholdDigestBill[];
    overdueCount: number;
    /** Varying bills that came due with nobody having said what they cost. Counted apart from {@link overdueCount}. */
    needsAmountCount: number;
}

export interface HouseholdDigestBill {
    id: string;
    channelId: string;
    description: string;
    dueAt: string;
    /** Null while the amount is still unknown. Never rendered as zero. */
    amountMinor?: number | null;
    currency: string;
    /** What this period will cost the caller. Null when there is no total yet, or the split no longer resolves. */
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
    /** The recipe's title or the entry's free text, flattened into one line. */
    title: string;
    cookUserId?: string | null;
}

export interface HouseholdDigestMaintenance {
    brokenCount: number;
    serviceOverdueCount: number;
    /** Warranties lapsing soon. Already-lapsed ones are not counted. */
    warrantyExpiringCount: number;
    /** The few worth showing, most urgent first. */
    attention: HouseholdDigestAsset[];
}

export interface HouseholdDigestAsset {
    id: string;
    channelId: string;
    name: string;
    status: AssetStatus;
    /** The single most urgent of the attention board's tokens; the full board carries all of them. */
    reason: string;
}

export interface HouseholdDigestAbsence {
    userId: string;
    startAt: string;
    /** Exclusive. */
    endAt: string;
    note?: string | null;
}

/** A digest plus the `ETag` it came with. */
export interface HouseholdDigestResponse {
    /** Null when {@link notModified}: the caller's existing copy is still current. */
    digest: HouseholdDigest | null;
    /** Null when the server sent none, or when the browser will not expose it. The next fetch is then unconditional. */
    etag: string | null;
    /** The server answered `304`: nothing changed since the tag that was sent with the request. */
    notModified: boolean;
}

/** Whether a digest has anything at all to draw. Distinct from "every section is null". */
export function isDigestEmpty(digest: HouseholdDigest | null | undefined): boolean {
    if (!digest) return true;
    return (
        !digest.chores?.mine.length &&
        !digest.chores?.houseOverdueCount &&
        !digest.lists?.some(l => l.openCount > 0) &&
        !digest.pantry?.expiringCount &&
        !digest.ledger?.some(l => l.myNetMinor !== 0) &&
        !digest.decisions?.openCount &&
        !digest.homeStatus?.length &&
        !digest.bills?.dueSoon.length &&
        !digest.meals?.today.length &&
        // The counts and not `attention.length`, which is capped.
        !digest.maintenance?.brokenCount &&
        !digest.maintenance?.serviceOverdueCount &&
        !digest.maintenance?.warrantyExpiringCount &&
        !digest.away?.length
    );
}
