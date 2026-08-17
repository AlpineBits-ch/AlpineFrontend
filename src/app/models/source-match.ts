import {ScreenSource} from '../services/rust-media.service';

/** The parts of a name worth scoring on. Single characters are dropped; they match far too much. */
function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(token => token.length > 1);
}

/**
 * The capturable window most likely to be the game an activity names, or nothing.
 * A weak score returns null rather than the best of a bad set, and monitors are never matched.
 */
export function bestSourceMatch(
    activityName: string,
    sources: readonly ScreenSource[],
): string | null {
    const wanted = tokenize(activityName);
    if (!wanted.length) return null;

    let best: {id: string; score: number} | null = null;

    for (const source of sources) {
        if (source.isMonitor) continue;

        const have = new Set(tokenize(source.name));
        const score = wanted.filter(token => have.has(token)).length / wanted.length;

        if (!best || score > best.score) best = {id: source.id, score};
    }

    // Two thirds of the activity's tokens have to appear.
    return best && best.score >= 0.67 ? best.id : null;
}
