/**
 * Write shapes for the Chores module, as `Guild.Application.Dtos.Request.CreateChoreDto` and
 * `UpdateChoreDto` deserialize them.
 *
 * <p>There is deliberately no request type for an occurrence. Occurrences are generated
 * server-side from the chore's cadence - the only things a client sends about one are the four
 * verbs (complete / un-complete / skip / swap), and none of them takes a body.</p>
 */

/** The server's own defaults for the three cadence fields, applied when the key is absent. */
export const CHORE_DEFAULTS = {
    intervalDays: 7,
    effortMinutes: 15,
    graceHours: 24,
} as const;

export interface CreateChoreDto {
    /** Required, trimmed server-side, and at most `CHORE_LIMITS.titleMaxLength` characters. */
    title: string;
    description?: string | null;
    /** 1-365. Omitted means {@link CHORE_DEFAULTS.intervalDays}. */
    intervalDays?: number;
    /**
     * ISO-8601. The first due date; the cadence steps from here.
     *
     * <p>Optional, and genuinely so: the server anchors an omitted one at *now*. Only sendable on
     * create - `UpdateChoreDto` has no anchor at all, because re-phasing a live rota would move
     * every turn already generated from it.</p>
     */
    anchorAt?: string | null;
    /**
     * 1-600. The fairness weight - a five-minute chore must not count as a forty-minute one.
     * Omitted means {@link CHORE_DEFAULTS.effortMinutes}.
     */
    effortMinutes?: number;
    /**
     * Exactly one of these two must be set on create; the server answers `400` otherwise.
     *
     * <p>Note the asymmetry with PATCH: the server applies either field only when it is
     * <b>non-null</b>, so sending `null` does not clear the other one. A chore that has a
     * `rotationRoleId` therefore cannot be moved back to a fixed assignee from here - the rotation
     * wins in `ChoreRotationService.GetRotationPoolAsync`, and there is no request shape that
     * unsets it.</p>
     */
    rotationRoleId?: string | null;
    fixedAssigneeUserId?: string | null;
    /** 0-336. Omitted means {@link CHORE_DEFAULTS.graceHours}. */
    graceHours?: number;
}

/**
 * PATCH semantics: only the fields you send are touched.
 *
 * <p>`anchorAt` is absent on purpose - it is not a field on the server's `UpdateChoreDto`, so
 * sending one is silently discarded rather than rejected, which is the worst of both worlds.
 * `isPaused` is edit-only for the mirror-image reason: a chore is created running.</p>
 */
export type UpdateChoreDto = Partial<Omit<CreateChoreDto, 'anchorAt'>> & {isPaused?: boolean};
