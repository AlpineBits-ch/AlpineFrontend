/** Holding a share's tile across the gap between one track ending and the next one arriving. */

/** How long a tile is held for a picture that has not come back yet. */
export const SCREEN_RESUME_GRACE_MS = 6_000;

/** Keys currently being held, and the timers that give up on them. The caller decides what expiry does. */
export class ScreenResumeTracker {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        /** Called with the key when nothing came back in time. Never called for an adopted resume. */
        private readonly onExpired: (key: string) => void,
        private readonly graceMs: number = SCREEN_RESUME_GRACE_MS,
    ) {
    }

    /** Start, or restart, the window for `key`. It measures from the most recent loss. */
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

    /** Stop holding `key` without expiring it: the picture came back, or the share really ended. */
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

    /** Drop everything, expiring nothing. For leaving the call: a late expiry can resurrect dead state. */
    clear(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}
