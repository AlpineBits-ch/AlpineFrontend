/**
 * How much room a post has left. The ceiling is per guild and plan-derived, so it differs between
 * servers the same person writes in, and a client that hardcodes one number is wrong somewhere.
 */

/** Nothing on any plan goes above this, so it stands in while the guild's own answer is unknown. */
export const MESSAGE_LENGTH_HARD_CEILING = 15_000;

/** Past this share of the ceiling the counter starts colouring. Below it, it is plain. */
const COUNTER_AT = 0.6;

/** Past this share it stops being informational. */
const NEAR_AT = 0.9;

export type LengthLevel = 'idle' | 'approaching' | 'near' | 'over';

export interface LengthState {
    length: number;
    /** Null while the guild's plan has not been read; nothing is blocked in that state. */
    max: number | null;
    /** Negative once the post is too long, which is what the counter shows. */
    remaining: number | null;
    level: LengthLevel;
    /** Whether to draw the counter at all. False only while the ceiling is unknown. */
    visible: boolean;
    /** The post cannot be sent as it stands. */
    blocked: boolean;
}

export function lengthState(length: number, max: number | null): LengthState {
    if (max === null || max <= 0) {
        // Unknown ceiling: count nothing, block nothing, and let the server be the authority. The
        // hard ceiling is the one thing no plan can exceed, so it is the only guard worth keeping.
        const blocked = length > MESSAGE_LENGTH_HARD_CEILING;
        return {
            length,
            max: null,
            remaining: null,
            level: blocked ? 'over' : 'idle',
            visible: blocked,
            blocked,
        };
    }

    const remaining = max - length;
    const used = length / max;

    let level: LengthLevel = 'idle';
    if (remaining < 0) level = 'over';
    else if (used >= NEAR_AT) level = 'near';
    else if (used >= COUNTER_AT) level = 'approaching';

    return {
        length,
        max,
        remaining,
        level,
        visible: true,
        blocked: remaining < 0,
    };
}

/** Tailwind classes for the counter, so the three states cannot drift between surfaces. */
export function lengthCounterClass(level: LengthLevel): string {
    switch (level) {
        case 'over':
            return 'text-offline font-semibold';
        case 'near':
            return 'text-connecting';
        default:
            return 'text-text-muted';
    }
}

/**
 * What the server will actually enforce: the plan's ceiling when it names one, the instance hard
 * ceiling otherwise, and never more than the hard ceiling. An unlimited plan resolves to null
 * upstream, which is why "no plan ceiling" has to mean the hard one rather than no counter at all.
 */
export function effectiveCeiling(planMax: number | null): number {
    if (planMax === null || planMax <= 0) return MESSAGE_LENGTH_HARD_CEILING;
    return Math.min(planMax, MESSAGE_LENGTH_HARD_CEILING);
}
