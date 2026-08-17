/**
 * "I'm away" - a dated plan that the chore rota reads.
 *
 * <p><b>This is not home status.</b> Home status is a decaying assertion about right now: somebody
 * who never clears "Out" must stop claiming to be out by Thursday, which is why it expires on its
 * own. An absence is a fortnight in Lisbon with a start and an end, still true while nobody is
 * looking at it, and the rota consults it to decide whose turn the bins are. Merging the two would
 * either give a holiday an expiry it does not have or give "back in an hour" a permanence it must
 * not - and the second is what starts assigning chores to somebody on a plane.</p>
 *
 * <p>So they are kept visually distinct everywhere they appear together.</p>
 */
export interface Absence {
    id: string;
    guildId: string;
    userId: string;
    startAt: string;
    /** **Exclusive**: an absence ending at 09:00 does not cover a chore due at 09:00. */
    endAt: string;
    /** "In Lisbon". Optional, and shown to the house. */
    note?: string | null;
    /** `ManageGuild` can amend somebody's absence, so this is not always {@link userId}. */
    createdByUserId: string;
    createdAt: string;
}

/**
 * What declaring or amending an absence actually did.
 *
 * <p>{@link choresReassigned} exists so the member can check the consequence before they get on the
 * plane rather than discover it afterwards - the write hands their unfinished chores in the window
 * to the lightest-loaded other flatmate.</p>
 *
 * <p><b>Shortening or deleting an absence does not claw them back.</b> That has to be in the confirm
 * copy, because everyone expects the opposite: the chores went to a person who has since planned
 * around having them.</p>
 */
export interface AbsenceSaved {
    absence: Absence;
    choresReassigned: number;
}

/** The server's own bounds, mirrored so the form refuses before the round trip. */
export const ABSENCE_LIMITS = {
    maxDays: 180,
    /** Live absences per member. Past ones do not count against it. */
    maxPerMember: 20,
    noteMaxLength: 200,
} as const;

/** Where an absence sits relative to now. Three states, because they read very differently. */
export type AbsenceState = 'past' | 'current' | 'upcoming';

export function absenceState(absence: Absence, now: number = Date.now()): AbsenceState {
    // `endAt` is exclusive, so an absence ending at this exact instant is already over.
    if (new Date(absence.endAt).getTime() <= now) return 'past';
    return new Date(absence.startAt).getTime() <= now ? 'current' : 'upcoming';
}

/**
 * Why a draft would be refused, or `null`.
 *
 * <p>Overlaps are deliberately **not** checked here. The server rejects them with a `400` naming
 * the collision rather than merging, and it is the only side that knows the member's other
 * absences - guessing at it client-side from a partially loaded board would refuse valid dates.</p>
 */
export function absenceDraftError(
    startAt: Date | null,
    endAt: Date | null,
): 'missing' | 'inverted' | 'too-long' | null {
    if (!startAt || !endAt) return 'missing';
    const span = endAt.getTime() - startAt.getTime();
    if (span <= 0) return 'inverted';
    return span > ABSENCE_LIMITS.maxDays * 86_400_000 ? 'too-long' : null;
}

// ── Realtime (server → client) ──────────────────────────────────────────────
//
// Guild-scoped, not channel-scoped: an absence belongs to a member and to the rota, not to any one
// board, so these arrive on the guild broadcast rather than on a household channel's.

export interface AbsenceCreated {
    guildId: string;
    absence: Absence;
    choresReassigned: number;
}

export type AbsenceUpdated = AbsenceCreated;

export interface AbsenceDeleted {
    guildId: string;
    absenceId: string;
    userId: string;
}
