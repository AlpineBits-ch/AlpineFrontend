import {DestroyRef, inject, Injectable, Signal, signal} from '@angular/core';
import {ServerClockService} from './server-clock.service';

/** 1 Hz while a timer still shows seconds that change meaningfully. */
const FAST_TICK_MS = 1_000;

/**
 * 30 s once everything on screen is over a minute old.
 *
 * <p>Past a minute the card renders `mm:ss` where the minutes are what anyone reads, so a 1 Hz
 * repaint of 200 rows buys a second hand nobody is watching. Half a minute is the coarsest cadence
 * that still cannot show a stale minute for longer than it takes to notice.</p>
 */
const SLOW_TICK_MS = 30_000;

/** Below this age a timer is still counting seconds visibly, so it earns 1 Hz. */
const FAST_WINDOW_MS = 60_000;

/**
 * The single clock behind every elapsed timer in the app.
 *
 * <p><b>Why a service and not a `setInterval` per component.</b> Rich presence renders in the guild
 * member list, which pages in 50 members at a time and routinely holds 200. A per-row interval is
 * 200 timers, 200 wakeups a second, and 200 change-detection entry points — on a list where the
 * overwhelming majority of rows are showing a number that changes once a minute. This service holds
 * exactly one timer no matter how many rows exist, and it does not run at all when nothing is
 * rendering a timer.</p>
 *
 * <p><b>The cadence adapts to what is actually on screen.</b> Consumers {@link retain} the
 * `startedAt` they are rendering; the ticker runs at 1 Hz while the youngest of them is under a
 * minute old and drops to 30 s once they are all past it. So a freshly launched game counts seconds
 * smoothly, and a room full of people six hours into a session costs two wakeups a minute.</p>
 *
 * <p>Time comes from {@link ServerClockService}, not `Date.now()` — see that class for why a local
 * clock cannot be trusted with an absolute `startedAt`.</p>
 */
@Injectable({providedIn: 'root'})
export class ActivityTickerService {
    private readonly clock = inject(ServerClockService);

    /**
     * Server-corrected "now", epoch ms. Read it in a template beside the value being formatted —
     * `{{ a.startedAt | activityElapsed: ticker.now() }}` — which is the convention
     * {@link RelativeTimePipe} already documents for keeping a pure pipe live.
     */
    private readonly _now = signal(Date.now());
    readonly now = this._now.asReadonly();

    /**
     * Every `startedAt` currently being rendered, by retention token. A `Map` rather than a count
     * because the cadence question is "how old is the youngest of these", which needs the values.
     */
    private readonly retained = new Map<number, Signal<number | null | undefined>>();
    private nextToken = 1;

    private handle?: ReturnType<typeof setInterval>;
    private cadence = 0;

    /**
     * Registers a timestamp as on-screen for as long as the calling context lives.
     *
     * <p>Must be called from an injection context (a component field initializer or constructor):
     * release is wired to that context's {@link DestroyRef}, so there is no `ngOnDestroy` to forget
     * and no way for a destroyed row to keep the fast cadence alive.</p>
     *
     * <p>Takes a signal rather than a number because a row's activity changes underneath it — the
     * member whose game switched should re-enter the fast window without re-registering.</p>
     */
    retain(startedAt: Signal<number | null | undefined>): void {
        const token = this.nextToken++;
        this.retained.set(token, startedAt);
        this.sync();

        inject(DestroyRef).onDestroy(() => {
            this.retained.delete(token);
            this.sync();
        });
    }

    /**
     * Starts, stops or re-paces the one timer to match what is retained.
     *
     * <p>Called on every retain/release and after every tick. Re-pacing tears the interval down and
     * builds it back up, which is only correct because it is cheap and because the cadence changes
     * at most once per activity — when it crosses the one-minute mark.</p>
     */
    private sync(): void {
        const wanted = this.wantedCadence();

        if (wanted === 0) {
            if (this.handle) {
                clearInterval(this.handle);
                this.handle = undefined;
                this.cadence = 0;
            }
            return;
        }

        this._now.set(this.clock.now());

        if (this.cadence === wanted && this.handle) return;

        if (this.handle) clearInterval(this.handle);
        this.cadence = wanted;
        this.handle = setInterval(() => {
            this._now.set(this.clock.now());
            // Re-checked every tick so a row that ages past a minute demotes the whole ticker
            // without anything having to notice on its behalf.
            this.sync();
        }, wanted);
    }

    /** `0` = nothing to tick, otherwise the interval the youngest retained timestamp deserves. */
    private wantedCadence(): number {
        if (this.retained.size === 0) return 0;

        const now = this.clock.now();
        let fast = false;
        let any = false;

        for (const startedAt of this.retained.values()) {
            const value = startedAt();
            if (value == null) continue;
            any = true;
            // `now - value` can be negative if the server stamped a moment ahead of our corrected
            // clock; that is a brand-new activity, which is the fastest case there is.
            if (now - value < FAST_WINDOW_MS) {
                fast = true;
                break;
            }
        }

        if (!any) return 0;
        return fast ? FAST_TICK_MS : SLOW_TICK_MS;
    }
}
