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
    /**
     * When somebody last nudged about this - and deliberately <b>not who</b>.
     *
     * <p>The nudger is anonymous in the payload and must stay anonymous in the UI. The entire value
     * of the feature is that the app does the asking so nobody in the house has to be the person
     * who nags; attributing it puts the social cost straight back where it was.</p>
     *
     * <p>Its job here is to grey the button. A second nudge inside twelve hours is a `409`, so
     * offering one is offering an action that cannot work.</p>
     */
    nudgedAt?: string | null;
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
    /**
     * How many days of the balance window this member was actually here.
     *
     * <p>The balance is weighted by it, so being away no longer reads as being behind. Surface it:
     * it is what lets the board <i>explain</i> the number rather than only state it. "40 minutes
     * light over the 16 days you were here" is a sentence people accept; the bare number is the
     * thing they argue with.</p>
     *
     * <p>Absent from a server that predates absences, which is why every reader has to tolerate
     * `undefined` and simply say less.</p>
     */
    presentDays?: number;
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
 * `guild.ChoreOccurrenceNudged` - somebody asked the assignee to get on with it.
 *
 * <p>The only occurrence event that carries a <b>fragment</b> rather than the whole row, and it is
 * short by exactly one field on purpose: there is no sender here, in the payload, in the alert or
 * in the copy. The app does the asking so that nobody in the house has to be the person who nags,
 * and naming them hands the social cost straight back.</p>
 */
export interface ChoreOccurrenceNudged {
    guildId: string;
    channelId: string;
    occurrenceId: string;
    nudgedAt: string;
}

/** How long a nudge holds off the next one, per occurrence. Mirrors `ChoreAlertService`. */
export const NUDGE_COOLDOWN_HOURS = 12;

/**
 * Whether a nudge would be accepted right now, judged from the row alone.
 *
 * <p>Every clause here mirrors a way the endpoint refuses, so the button can be hidden or greyed
 * rather than offered and then explained. It cannot see quiet hours - that answer lives on the
 * guild - so the remaining `409` is the caller's to handle.</p>
 */
export function canNudge(
    occurrence: ChoreOccurrence,
    graceHours: number,
    ownUserId: string | null,
    now: number = Date.now(),
): boolean {
    // Nudging yourself is not a thing, and rendering the button on your own row is the shape a
    // client bug takes - so it is checked first and unconditionally.
    if (!ownUserId || occurrence.assignedUserId === ownUserId) return false;
    // Done and skipped are both refused server-side. A skip is still outstanding work, but it is
    // not this occurrence's any more - the rota will hand it back round on its own.
    if (occurrence.completedAt || occurrence.skippedAt) return false;

    const dueMs = new Date(occurrence.dueAt).getTime();
    if (Number.isNaN(dueMs)) return false;
    // Only once it is genuinely late. A nudge about something not yet overdue is not a reminder,
    // it is a person leaning over your shoulder - which is what gets the feature muted.
    if (dueMs + graceHours * 3_600_000 >= now) return false;

    if (!occurrence.nudgedAt) return true;
    const last = new Date(occurrence.nudgedAt).getTime();
    return Number.isNaN(last) || now - last >= NUDGE_COOLDOWN_HOURS * 3_600_000;
}

/** When the cooldown lapses, or `null` when nobody has nudged. For the greyed button's tooltip. */
export function nextNudgeAt(occurrence: ChoreOccurrence): Date | null {
    if (!occurrence.nudgedAt) return null;
    const last = new Date(occurrence.nudgedAt).getTime();
    return Number.isNaN(last) ? null : new Date(last + NUDGE_COOLDOWN_HOURS * 3_600_000);
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
 * The due-date reminder is <b>not</b> here any more.
 *
 * <p>`guild.ChoreReminder` is gone, folded into the one envelope every household notification now
 * arrives in: `guild.HouseholdAlert` with `kind: "chore.due"`, `targetId` the occurrence id, and
 * `choreId`/`dueAt` moved into `data`. See
 * {@link import('./household-alert.dto').HouseholdAlert} - and note it is handled by
 * {@link import('../../services/household-alert.service').HouseholdAlertService} rather than by
 * the chore service, because a reminder has to reach somebody who is not looking at the board.</p>
 */

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
