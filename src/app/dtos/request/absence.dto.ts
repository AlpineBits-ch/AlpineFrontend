/**
 * Absence write bodies.
 *
 * <p>There is no `userId` on either of them, and that is the rule rather than an omission:
 * `POST /absences` writes **your own only**, and `ManageGuild` can amend or delete somebody else's
 * but cannot create one. Inventing an absence for a flatmate would move their chores off them
 * without their knowing.</p>
 */

export interface CreateAbsenceDto {
    startAt: string;
    /** Exclusive. */
    endAt: string;
    note?: string;
}

/** A partial patch; `clearNote` is how a note is removed, since null reads as "leave alone". */
export interface UpdateAbsenceDto {
    startAt?: string;
    endAt?: string;
    note?: string;
    clearNote?: boolean;
}
