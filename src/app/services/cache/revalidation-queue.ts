/**
 * Background work that must never crowd out the app's own requests.
 *
 * <p>Profile revalidation asks for every id the cache holds. Fired at once that is exactly the
 * burst the circuit breaker exists to absorb, and the breaker answering it with fallback profiles
 * would put "Unknown User" on screen - the very thing the cache was added to stop. So this bounds
 * both how many run together and how closely together they start.</p>
 *
 * <p>A task's failure is swallowed. These are refreshes of data already on screen: the cached copy
 * stays, the next launch tries again, and there is no caller waiting on the answer.</p>
 */
export class RevalidationQueue {
    private readonly queued: (() => Promise<void>)[] = [];
    private running = 0;
    private lastStart = Number.NEGATIVE_INFINITY;
    private idle: (() => void)[] = [];

    constructor(
        private readonly concurrency: number,
        private readonly minGapMs: number,
        private readonly now: () => number = () => Date.now(),
        private readonly delay: (ms: number) => Promise<void> =
            ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) {}

    get pending(): number {
        return this.queued.length + this.running;
    }

    push(task: () => Promise<void>): void {
        this.queued.push(task);
        void this.pump();
    }

    /** Resolves once everything queued so far has settled. */
    drain(): Promise<void> {
        if (this.pending === 0) return Promise.resolve();
        return new Promise<void>(resolve => this.idle.push(resolve));
    }

    private async pump(): Promise<void> {
        if (this.running >= this.concurrency) return;

        const task = this.queued.shift();
        if (!task) {
            if (this.running === 0) this.settle();
            return;
        }

        const gap = this.minGapMs - (this.now() - this.lastStart);
        if (gap > 0) await this.delay(gap);

        this.lastStart = this.now();
        this.running++;

        try {
            await task();
        } catch {
            // Deliberately swallowed. See the class comment.
        } finally {
            this.running--;
        }

        void this.pump();
    }

    private settle(): void {
        const waiting = this.idle;
        this.idle = [];
        for (const resolve of waiting) resolve();
    }
}
