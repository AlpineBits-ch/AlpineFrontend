/**
 * The Chores module: chore definitions, the occurrences the server generates from them, and the
 * fairness balance. Clients never create occurrences, and the balance credits the assignee.
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
    /** The first due date, not "when it was created". Editing it re-phases the whole rota. */
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
    /** Whose turn it is. The balance credits this user, whoever actually did it. */
    assignedUserId: string;
    /** Snapshot at generation time; re-weighting a chore does not rewrite history. */
    effortMinutes: number;
    completedAt?: string | null;
    /** Who actually did it. May legitimately differ from {@link assignedUserId}. */
    completedByUserId?: string | null;
    /** Set means skipped, and skipped is not done. See {@link occurrenceStatus}. */
    skippedAt?: string | null;
    isOverdue: boolean;
    /** When somebody last nudged, never who. The nudger stays anonymous in the UI. */
    nudgedAt?: string | null;
}

/** One member's standing over the balance window. */
export interface ChoreBalanceEntry {
    userId: string;
    completedMinutes: number;
    completedCount: number;
    /** Weighted minutes relative to the household average, never an absolute total. Negative means behind. */
    balanceMinutes: number;
    /** How many days of the balance window this member was actually here. Absent on older servers. */
    presentDays?: number;
}

// ── Realtime payloads ───────────────────────────────────────────────────────
// Field names taken from asyncapi.json (`components.messages.guild_Chore*`), which is the contract.

/** `guild.ChoreCreated` */
export interface ChoreCreated {
    guildId: string;
    channelId: string;
    chore: Chore;
}

/** `guild.ChoreUpdated`, a byte-identical envelope to {@link ChoreCreated}, kept separate for call sites. */
export interface ChoreUpdated {
    guildId: string;
    channelId: string;
    chore: Chore;
}

/** `guild.ChoreDeleted`, id only. The chore's occurrences go with it and are not enumerated. */
export interface ChoreDeleted {
    guildId: string;
    channelId: string;
    choreId: string;
}

/** `guild.ChoreOccurrenceCreated`: the server generated a turn. */
export interface ChoreOccurrenceCreated {
    guildId: string;
    channelId: string;
    occurrence: ChoreOccurrence;
}

/** `guild.ChoreOccurrenceUpdated`: complete, un-complete, skip and swap all send a full snapshot. */
export interface ChoreOccurrenceUpdated {
    guildId: string;
    channelId: string;
    occurrence: ChoreOccurrence;
}

/** `guild.ChoreOccurrenceNudged`: a fragment, not the whole row, and it carries no sender. */
export interface ChoreOccurrenceNudged {
    guildId: string;
    channelId: string;
    occurrenceId: string;
    nudgedAt: string;
}

/** How long a nudge holds off the next one, per occurrence. Mirrors `ChoreAlertService`. */
export const NUDGE_COOLDOWN_HOURS = 12;

/** Whether a nudge would be accepted right now, judged from the row alone. Cannot see quiet hours. */
export function canNudge(
    occurrence: ChoreOccurrence,
    graceHours: number,
    ownUserId: string | null,
    now: number = Date.now(),
): boolean {
    if (!ownUserId || occurrence.assignedUserId === ownUserId) return false;
    // Done and skipped are both refused server-side.
    if (occurrence.completedAt || occurrence.skippedAt) return false;

    const dueMs = new Date(occurrence.dueAt).getTime();
    if (Number.isNaN(dueMs)) return false;
    // Only once it is genuinely late.
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

/** Whether an arriving payload actually carries its occurrence. A guard against older servers. */
export function carriesOccurrence(payload: ChoreOccurrenceUpdated): boolean {
    const candidate = payload as Partial<ChoreOccurrenceUpdated>;
    return !!candidate.occurrence && typeof candidate.occurrence === 'object';
}

// ── Derived state ───────────────────────────────────────────────────────────

/** How one occurrence should read. `skipped` resolves first: never present a skip as done. */
export type ChoreOccurrenceStatus = 'skipped' | 'done' | 'overdue' | 'due';

export function occurrenceStatus(occurrence: ChoreOccurrence): ChoreOccurrenceStatus {
    if (occurrence.skippedAt) return 'skipped';
    if (occurrence.completedAt) return 'done';
    return occurrence.isOverdue ? 'overdue' : 'due';
}

/** Done, and only done. A skip returns `false` here. */
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

/** Someone other than the assignee did it. The UI names both; the balance credits `assignedUserId`. */
export function wasDoneByProxy(occurrence: ChoreOccurrence): boolean {
    return (
        isChoreDone(occurrence) &&
        !!occurrence.completedByUserId &&
        occurrence.completedByUserId !== occurrence.assignedUserId
    );
}

/** Which side of their share a member is on. `balanceMinutes` is a delta, never a total. */
export type ChoreStanding = 'behind' | 'ahead' | 'even';

export function balanceStanding(entry: ChoreBalanceEntry): ChoreStanding {
    if (entry.balanceMinutes < 0) return 'behind';
    if (entry.balanceMinutes > 0) return 'ahead';
    return 'even';
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Every bound `ChoreEndpoint` checks before it writes, mirrored so the form can refuse a draft. */
export const CHORE_LIMITS = {
    /** `MaxTitleLength` in ChoreEndpoint. Measured after trimming, as the server measures it. */
    titleMaxLength: 100,
    intervalDaysMin: 1,
    intervalDaysMax: 365,
    effortMinutesMin: 1,
    effortMinutesMax: 600,
    graceHoursMin: 0,
    /** Two weeks. */
    graceHoursMax: 336,
    /** The window `GET .../chores/balance` defaults to, and what "fewest weighted minutes" spans. */
    balanceDefaultDays: 30,
} as const;

/** Why an assignment is not acceptable, or `null` when it is. Exactly one of the two must be set. */
export function choreAssignmentError(
    draft: Pick<Chore, 'rotationRoleId' | 'fixedAssigneeUserId'>,
): 'missing' | 'both' | null {
    const hasRole = !!draft.rotationRoleId;
    const hasFixed = !!draft.fixedAssigneeUserId;
    if (hasRole && hasFixed) return 'both';
    if (!hasRole && !hasFixed) return 'missing';
    return null;
}
