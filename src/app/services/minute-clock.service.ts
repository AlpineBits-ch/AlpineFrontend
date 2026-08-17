import {DestroyRef, inject, Injectable, signal} from '@angular/core';
import {ServerClockService} from './server-clock.service';

/**
 * 30 s. The smallest unit anything reading this clock renders is a minute, so half a minute is the
 * coarsest cadence that cannot leave a stale minute on screen for longer than it takes to notice.
 */
const TICK_MS = 30_000;

/**
 * The one clock behind everything that renders a <i>scheduled</i> time - "ends in 40m" on an event
 * card, the live badge on the sidebar's Events row, the LIVE pill on a voice channel.
 *
 * <p><b>Why not {@link ActivityTickerService}.</b> That service exists for the same reason and would
 * be the obvious thing to reuse, but its cadence logic asks "how old is the youngest retained
 * timestamp" and drops to 1 Hz below a minute. Every timestamp here is in the <i>future</i>, so
 * `now - startsAt` is negative, which satisfies that test permanently - retaining an event there
 * would pin the entire app at 1 Hz for as long as any upcoming event is on screen.</p>
 *
 * <p><b>Why not `Date.now()`.</b> Events carry absolute server-issued timestamps, and the local
 * clock is routinely wrong by hours - see {@link ServerClockService}, which exists for exactly that
 * failure. Reading through it means a machine with a dead CMOS battery still sees the right event
 * as live.</p>
 *
 * <p>Retention is ref-counted, so the interval does not run when nothing is rendering a time.</p>
 */
@Injectable({providedIn: 'root'})
export class MinuteClockService {
    private readonly clock = inject(ServerClockService);

    private readonly _now = signal(0);

    /**
     * Server-corrected "now", epoch ms. Read it beside the value being formatted -
     * `{{ event.endsAt | relativeTime: clock.now() }}` - which is the convention
     * {@link RelativeTimePipe} documents for keeping a pure pipe live.
     *
     * <p>Reads `0` until something {@link retain}s the clock. A consumer that reads it has by
     * definition retained it, so the initial value is never rendered.</p>
     */
    readonly now = this._now.asReadonly();

    private handle?: ReturnType<typeof setInterval>;
    private retainers = 0;

    /**
     * Marks the clock as on-screen for as long as the calling context lives.
     *
     * <p>Must be called from an injection context (a component constructor or field initializer):
     * release is wired to that context's {@link DestroyRef}, so there is no `ngOnDestroy` to
     * forget and no way for a destroyed component to keep the timer alive.</p>
     */
    retain(): void {
        this.retainers++;
        this.sync();

        inject(DestroyRef).onDestroy(() => {
            this.retainers--;
            this.sync();
        });
    }

    /** Starts or stops the one timer to match whether anything is retaining it. */
    private sync(): void {
        if (this.retainers > 0) {
            // Sampled on retain as well as on the interval, so a component that mounts 29 s into a
            // tick does not render a value that is most of a tick stale.
            this._now.set(this.clock.now());
            this.handle ??= setInterval(() => this._now.set(this.clock.now()), TICK_MS);
            return;
        }

        if (this.handle) {
            clearInterval(this.handle);
            this.handle = undefined;
        }
    }
}
