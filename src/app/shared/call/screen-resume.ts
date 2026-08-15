/**
 * Holding a share's tile across the gap between one track ending and the next one arriving.
 *
 * <p><b>The problem this exists for.</b> A screen share's track closing normally means the share
 * ended, and dropping the tile is the honest answer. But several ordinary things end one track and
 * open another under a new id a second or two later: a sharer switching from a window to a monitor,
 * a publication that gave up after a run of failed writes, a network blip, a browser publish
 * renegotiating. Every one of those used to read as "stopped sharing" on every viewer - the tile
 * left the grid, the layout reflowed under it, an invite card could appear where the stream had
 * been, and anyone watching that stream maximised was left staring at an empty stage until the
 * replacement was announced.</p>
 *
 * <p>So a closed track marks the share as resuming rather than removing it. If a replacement
 * arrives inside the window it is adopted in place; if nothing does, the tile finally goes.</p>
 *
 * <p>Deliberately not a service. Both call surfaces need exactly this and they hold their rosters in
 * completely different shapes - a guild channel keys by user, a DM call by share - so what is shared
 * is the timing rule and the bookkeeping, not the state.</p>
 */

/**
 * How long a tile is held for a picture that has not come back yet.
 *
 * <p>Long enough to cover the slow end of what actually reappears: a source switch has to tear down
 * a capture session and negotiate a new one, which is seconds rather than milliseconds on a busy
 * machine. Short enough that a share which genuinely ended does not leave a frozen ghost on the
 * stage long enough to be mistaken for a stream nobody is watching.</p>
 */
export const SCREEN_RESUME_GRACE_MS = 6_000;

/**
 * Keys currently being held, and the timers that give up on them.
 *
 * <p>A key is whatever the surface identifies a share by - a user id on the guild stage, a share id
 * in a DM call. This does not care which, and deliberately holds no opinion about what expiry
 * means: the caller passes what to do, because on one surface it is a roster patch and on the other
 * it is a list splice.</p>
 */
export class ScreenResumeTracker {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        /** Called with the key when nothing came back in time. Never called for an adopted resume. */
        private readonly onExpired: (key: string) => void,
        private readonly graceMs: number = SCREEN_RESUME_GRACE_MS,
    ) {
    }

    /**
     * Start (or restart) the window for `key`.
     *
     * <p>Restarting rather than ignoring a second call is deliberate: a share that flaps twice is
     * still a share that might come back, and the window should measure from the most recent loss
     * rather than expire early because of an earlier one.</p>
     */
    hold(key: string): void {
        this.cancel(key);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            this.onExpired(key);
        }, this.graceMs));
    }

    /** Whether `key` is being held right now. */
    isHeld(key: string): boolean {
        return this.timers.has(key);
    }

    /** Stop holding `key` without expiring it - the picture came back, or the share really ended. */
    cancel(key: string): boolean {
        const timer = this.timers.get(key);
        if (timer === undefined) return false;
        clearTimeout(timer);
        this.timers.delete(key);
        return true;
    }

    /** Every key currently held. */
    held(): string[] {
        return [...this.timers.keys()];
    }

    /**
     * Drop everything, expiring nothing.
     *
     * <p>For leaving the call. An expiry that fires after the roster it patches is gone would either
     * do nothing or, worse, resurrect state for a channel this client has left.</p>
     */
    clear(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}
