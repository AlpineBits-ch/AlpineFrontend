import {describe, expect, it} from 'vitest';

import {RevalidationQueue} from './revalidation-queue';

/** A controllable clock, so these tests assert on pacing without sleeping. */
function fakeClock() {
    let t = 0;
    return {
        now: () => t,
        delay: async (ms: number) => { t += ms; },
        advance: (ms: number) => { t += ms; },
    };
}

describe('RevalidationQueue', () => {
    it('runs every task it is given', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(2, 10, clock.now, clock.delay);
        const done: number[] = [];

        for (let i = 0; i < 5; i++) queue.push(async () => { done.push(i); });
        await queue.drain();

        expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    it('never exceeds its concurrency', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(2, 0, clock.now, clock.delay);
        let live = 0;
        let peak = 0;

        for (let i = 0; i < 8; i++) {
            queue.push(async () => {
                live++;
                peak = Math.max(peak, live);
                await Promise.resolve();
                live--;
            });
        }
        await queue.drain();

        expect(peak).toBeLessThanOrEqual(2);
    });

    it('a failing task does not stop the queue', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(1, 0, clock.now, clock.delay);
        const done: string[] = [];

        queue.push(async () => { throw new Error('429'); });
        queue.push(async () => { done.push('after'); });
        await queue.drain();

        expect(done).toEqual(['after']);
    });

    it('paces tasks by the minimum gap', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(1, 100, clock.now, clock.delay);
        const at: number[] = [];

        for (let i = 0; i < 3; i++) queue.push(async () => { at.push(clock.now()); });
        await queue.drain();

        expect(at[1] - at[0]).toBeGreaterThanOrEqual(100);
        expect(at[2] - at[1]).toBeGreaterThanOrEqual(100);
    });

    it('drain resolves immediately when nothing was queued', async () => {
        const clock = fakeClock();
        await new RevalidationQueue(2, 10, clock.now, clock.delay).drain();
    });

    it('never exceeds its concurrency when also paced by a non-zero gap', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(2, 50, clock.now, clock.delay);
        let live = 0;
        let peak = 0;

        for (let i = 0; i < 6; i++) {
            queue.push(async () => {
                live++;
                peak = Math.max(peak, live);
                await Promise.resolve();
                await Promise.resolve();
                live--;
            });
        }
        await queue.drain();

        expect(peak).toBeLessThanOrEqual(2);
    });

    it('drain does not resolve while a task is still waiting on the pacing gap', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(2, 50, clock.now, clock.delay);
        const ran: number[] = [];

        // The first task starts immediately (no gap to wait on). The second is shifted out of
        // the internal queue right away too, but - because of the pacing gap - only reserves its
        // slot; it has not actually run by the time both pushes have returned.
        queue.push(async () => { ran.push(0); });
        queue.push(async () => {
            await Promise.resolve();
            ran.push(1);
        });
        await queue.drain();

        expect(ran.sort((a, b) => a - b)).toEqual([0, 1]);
    });
});
