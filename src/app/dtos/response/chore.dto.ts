/**
 * The Chores module: chore *definitions*, the *occurrences* the server generates from them,
 * and the fairness *balance* that decides who gets the next one.
 *
 * <p>Three things here are load-bearing and are not obvious from the shapes alone.</p>
 *
 * <p><b>Clients never create occurrences.</b> The server generates them from `anchorAt` +
 * `intervalDays` (on chore creation, then on schedule, with a five-minute reconcile sweep as a
 * backstop). There is no POST for one and no client-side cadence arithmetic anywhere in this
 * feature - a turn appears because `guild.ChoreOccurrenceCreated` said so.</p>
 *
 * <p><b>Skipping is not completing.</b> A skipped occurrence credits nothing, which is precisely
 * what makes the rotation land back on the same person. {@link occurrenceStatus} therefore checks
 * `skippedAt` <i>before</i> `completedAt`, so no caller can accidentally draw a skip as done.</p>
 *
 * <p><b>The balance credits the assignee, not the doer.</b> `completedByUserId` may differ from
 * `assignedUserId` and both must be shown - crediting the doer would let one flatmate farm the
 * ledger by doing everyone's five-minute chores.</p>
 */

// ── Server shapes ───────────────────────────────────────────────────────────

/** A chore definition: the cadence, the weight, and who is in the pool. */
export interface Chore {
    id: string;
    channelId: string;
    title: string;
    description?: string | null;
    /** 1-365. The cadence steps from {@link anchorAt} by this many days. */
    intervalDays: number;
    /** The first due date. Not "when it was created" - editing it re-phases the whole rota. */
    anchorAt: string;
    /** 1-600. The fairness weight: this is what "fewest weighted minutes" is counting. */
    effortMinutes: number;
    /** The rotation pool is simply this role's membership. Mutually exclusive with the next field. */
    rotationRoleId?: string | null;
    fixedAssigneeUserId?: string | null;
    /** How long past `dueAt` before an occurrence counts as overdue. */
    graceHours: number;
    isPaused: boolean;
    nextDueAt: string;
}

/** One generated turn at a chore. Server-authored, start to finish. */
export interface ChoreOccurrence {
    id: string;
    choreId: string;
    channelId: string;
    /** Denormalized off the chore so a board row renders without joining. */
    title: string;
    dueAt: string;
    /** Whose turn it is. <b>The balance credits this user</b>, whoever actually did it. */
    assignedUserId: string;
    /** Snapshot at generation time - re-weighting a chore does not rewrite history. */
    effortMinutes: number;
    completedAt?: string | null;
    /** Who actually did it. May legitimately differ from {@link assignedUserId}. */
    completedByUserId?: string | null;
    /** Set means skipped, and skipped is <b>not</b> done - see {@link occurrenceStatus}. */
    skippedAt?: string | null;
    isOverdue: boolean;
}

/** One member's standing over the balance window. */
export interface ChoreBalanceEntry {
    userId: string;
    completedMinutes: number;
    completedCount: number;
    /**
     * Weighted minutes <b>relative to the household average</b> - not an absolute total.
     * Negative means behind their share. Rendering this as "minutes done" is wrong in both
     * directions: it inflates a small house and it hides who is coasting in a large one.
     */
    balanceMinutes: number;
}

// ── Realtime payloads ───────────────────────────────────────────────────────
// Field names taken from asyncapi.json (`components.messages.guild_Chore*`), which is the
// contract; the prose guide describes the same events but not their envelopes.

/** `guild.ChoreCreated` */
export interface ChoreCreated {
    guildId: string;
    channelId: string;
    chore: Chore;
}

/** `guild.ChoreUpdated` - byte-identical envelope to {@link ChoreCreated}, kept separate for call sites. */
export interface ChoreUpdated {
    guildId: string;
    channelId: string;
    chore: Chore;
}

/** `guild.ChoreDeleted` - id only. The chore's occurrences go with it and are not enumerated. */
export interface ChoreDeleted {
    guildId: string;
    channelId: string;
    choreId: string;
}

/** `guild.ChoreOccurrenceCreated` - the server generated a turn. */
export interface ChoreOccurrenceCreated {
    guildId: string;
    channelId: string;
    occurrence: ChoreOccurrence;
}

/**
 * `guild.ChoreOccurrenceUpdated` - complete, un-complete, skip and swap all send a full snapshot.
 *
 * <p>Skip used to be the exception, broadcasting a bare `{occurrenceId, skipped}` marker with no
 * occurrence on it; the server no longer does that, and `POST /skip` returns the row as well
 * instead of an empty `200`. The union that carried the second shape is gone with it.</p>
 */
export interface ChoreOccurrenceUpdated {
    guildId: string;
    channelId: string;
    occurrence: ChoreOccurrence;
}

/**
 * Whether an arriving payload actually carries its occurrence.
 *
 * <p>The contract now says it always does. This stays as a guard rather than an assumption because
 * the cost of the two is wildly asymmetric: a server that has not been rolled forward yet sends the
 * old skip marker, and dereferencing `payload.occurrence.id` off `undefined` throws <i>inside the
 * SignalR callback</i>, which silently kills the rest of that dispatch - every later handler for the
 * same event included. Dropping one stale payload loses a skip that the next board load corrects.</p>
 */
export function carriesOccurrence(payload: ChoreOccurrenceUpdated): boolean {
    const candidate = payload as Partial<ChoreOccurrenceUpdated>;
    return !!candidate.occurrence && typeof candidate.occurrence === 'object';
}

/**
 * `guild.ChoreReminder` - this occurrence is due and the assignee is being told.
 *
 * <p>Sent <b>to the assignee only</b>, at most once per occurrence, and never for a chore that is
 * already more than twelve hours overdue - by then the board says so on its own, and it is what
 * stops a guild coming back from an outage buzzing everyone at once. A reminder that would land
 * inside the guild's quiet hours is held until the window ends and nothing is emitted meanwhile, so
 * there is no pending state to draw.</p>
 *
 * <p>The same event is the payload of the household push (`type: "household"`,
 * `kind: "chore.due"`, `targetId` the occurrence id). A member who has muted the guild still gets
 * this event and gets no push.</p>
 */
export interface ChoreReminder {
    guildId: string;
    channelId: string;
    occurrenceId: string;
    choreId: string;
    /** Denormalized, so a notification body renders without the board being loaded. */
    title: string;
    dueAt: string;
}

// ── Derived state ───────────────────────────────────────────────────────────

/**
 * How one occurrence should read. `skipped` is deliberately resolved first: nothing may present a
 * skip as done, including the impossible-but-defensible row that carries both stamps.
 */
export type ChoreOccurrenceStatus = 'skipped' | 'done' | 'overdue' | 'due';

export function occurrenceStatus(occurrence: ChoreOccurrence): ChoreOccurrenceStatus {
    if (occurrence.skippedAt) return 'skipped';
    if (occurrence.completedAt) return 'done';
    return occurrence.isOverdue ? 'overdue' : 'due';
}

/** Done, and only done. A skip returns `false` here - that is the entire point of this helper. */
export function isChoreDone(occurrence: ChoreOccurrence): boolean {
    return occurrenceStatus(occurrence) === 'done';
}

export function isChoreSkipped(occurrence: ChoreOccurrence): boolean {
    return occurrenceStatus(occurrence) === 'skipped';
}

/** Still owed: neither done nor skipped. What "unpaid work" means, and what the rota re-offers. */
export function isChoreOutstanding(occurrence: ChoreOccurrence): boolean {
    const status = occurrenceStatus(occurrence);
    return status === 'due' || status === 'overdue' || status === 'skipped';
}

/**
 * Someone other than the assignee did it - "Ben did Anna's washing-up".
 *
 * <p>The UI must name both; the balance still credits `assignedUserId`.</p>
 */
export function wasDoneByProxy(occurrence: ChoreOccurrence): boolean {
    return isChoreDone(occurrence)
        && !!occurrence.completedByUserId
        && occurrence.completedByUserId !== occurrence.assignedUserId;
}

/** Which side of their share a member is on. `balanceMinutes` is a delta, never a total. */
export type ChoreStanding = 'behind' | 'ahead' | 'even';

export function balanceStanding(entry: ChoreBalanceEntry): ChoreStanding {
    if (entry.balanceMinutes < 0) return 'behind';
    if (entry.balanceMinutes > 0) return 'ahead';
    return 'even';
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Every bound `ChoreEndpoint` checks before it writes, mirrored so a draft is refused by the form
 * rather than by a bare `400` with the field name buried in a string body.
 */
export const CHORE_LIMITS = {
    /** `MaxTitleLength` in ChoreEndpoint. Measured after trimming, as the server measures it. */
    titleMaxLength: 100,
    intervalDaysMin: 1,
    intervalDaysMax: 365,
    effortMinutesMin: 1,
    effortMinutesMax: 600,
    graceHoursMin: 0,
    /** Two weeks. Past this the "overdue" badge stops meaning anything, which is why it is capped. */
    graceHoursMax: 336,
    /** The window `GET .../chores/balance` defaults to, and what "fewest weighted minutes" spans. */
    balanceDefaultDays: 30,
} as const;

/**
 * Why an assignment is not acceptable, or `null` when it is.
 *
 * <p>A chore needs <b>exactly one</b> of `rotationRoleId` / `fixedAssigneeUserId`; the server
 * answers `400` otherwise, and a raw 400 next to two half-filled pickers tells the user nothing
 * about which one to fix. The form asks this before it asks the server.</p>
 */
export function choreAssignmentError(
    draft: Pick<Chore, 'rotationRoleId' | 'fixedAssigneeUserId'>,
): 'missing' | 'both' | null {
    const hasRole = !!draft.rotationRoleId;
    const hasFixed = !!draft.fixedAssigneeUserId;
    if (hasRole && hasFixed) return 'both';
    if (!hasRole && !hasFixed) return 'missing';
    return null;
}
