import {ScreenSource} from '../services/rust-media.service';

/**
 * The parts of a name worth scoring on.
 *
 * <p>Single characters are dropped: they are almost always separators that survived the split
 * ("Rocket League - v2" leaves a stray "v"), and a one-letter token matches far too much.</p>
 */
function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(token => token.length > 1);
}

/**
 * The capturable window most likely to be the game an activity names, or nothing.
 *
 * <p>Used to preselect a source in the screen picker, which the user still confirms. That is what
 * licenses the guess at all — but it is also why the guess is deliberately timid. A wrong
 * preselection on a window holding a password manager is worse than no preselection, so a weak
 * score returns null rather than the best of a bad set.</p>
 *
 * <p><b>Monitors are never matched.</b> Sharing a whole screen is a different decision from sharing
 * one game, and a monitor's name describes the hardware rather than what is on it — "Monitor 1"
 * would score zero anyway, but a display named after a game would score misleadingly well.</p>
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

    // Two thirds of the activity's tokens have to appear. Below that, "Microsoft Flight Simulator
    // 2024" starts matching a browser tab that merely says "Microsoft".
    return best && best.score >= 0.67 ? best.id : null;
}
