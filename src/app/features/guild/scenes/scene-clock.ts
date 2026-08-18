import {SceneDto, SceneStatus} from '../../../dtos/response/scene.dto';

/** Enough to draw a clock. A board row and a whole scene both satisfy it. */
export type SceneClockSource = Pick<SceneDto, 'status' | 'turnStartedAt' | 'turnDeadlineAt' | 'lastPostAt'>;

/** The turn's deadline as something drawable. Everything is null when there is no clock to draw. */
export interface TurnClock {
    hasDeadline: boolean;
    /** Negative once the deadline has passed. */
    remainingMs: number | null;
    /** How long this turn has been open, deadline or not. */
    elapsedMs: number | null;
    /** 0 when the turn opened, 1 at the deadline. Null when the turn's start is unknown. */
    spent: number | null;
    overdue: boolean;
}

const NO_CLOCK: TurnClock = {
    hasDeadline: false,
    remainingMs: null,
    elapsedMs: null,
    spent: null,
    overdue: false,
};

function time(value: string | null | undefined): number | null {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The current turn's clock. `turnStartedAt` is not in the locked surface, so the last post is used
 * as the turn's start when it is absent - the arc is then approximate rather than missing.
 */
export function turnClock(scene: SceneClockSource | null | undefined, now: number): TurnClock {
    if (!scene || scene.status !== SceneStatus.Active) return NO_CLOCK;

    const deadline = time(scene.turnDeadlineAt);
    const started = time(scene.turnStartedAt) ?? time(scene.lastPostAt);
    const elapsedMs = started === null ? null : now - started;

    if (deadline === null) return {...NO_CLOCK, elapsedMs};

    const remainingMs = deadline - now;
    const span = started === null ? null : deadline - started;
    const spent = span && span > 0 ? Math.min(Math.max((now - started!) / span, 0), 1) : null;

    return {hasDeadline: true, remainingMs, elapsedMs, spent, overdue: remainingMs <= 0};
}

/** How urgent the clock reads. Drives colour, and nothing else. */
export type ClockPressure = 'easy' | 'closing' | 'due' | 'over';

export function clockPressure(clock: TurnClock): ClockPressure {
    if (!clock.hasDeadline) return 'easy';
    if (clock.overdue) return 'over';
    if (clock.remainingMs !== null && clock.remainingMs < 3_600_000) return 'due';
    if (clock.spent !== null && clock.spent > 0.66) return 'closing';
    return 'easy';
}
