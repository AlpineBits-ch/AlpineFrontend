import {describe, expect, it} from 'vitest';
import {hydrateThenReveal, ProfileCacheHydrationSteps} from './profile-cache-hydration';

/**
 * Pins the ordering rule `MainPageComponent.runDeviceLaunch` relies on: hydration must finish
 * before the splash comes down, and a hydration fault must never be able to hold the splash up.
 *
 * <p>Asserted against {@link hydrateThenReveal} itself - the exact function the component calls -
 * rather than against local stand-ins that call each other, because a spec that only proves two
 * `vi.fn()`s can be awaited in order proves nothing about the application.</p>
 */
describe('hydrateThenReveal', () => {
    function steps(overrides: Partial<ProfileCacheHydrationSteps> = {}) {
        const calls: string[] = [];
        const base: ProfileCacheHydrationSteps = {
            hydrate: async () => {
                calls.push('hydrate');
                return 3;
            },
            revalidateAll: () => {
                calls.push('revalidateAll');
            },
            markReady: () => {
                calls.push('markReady');
            },
        };
        return {calls, steps: {...base, ...overrides}};
    }

    it('does not mark ready until hydration resolves', async () => {
        let resolveHydrate!: (count: number) => void;
        const {calls, steps: s} = steps({
            hydrate: () => new Promise<number>(resolve => {
                resolveHydrate = resolve;
            }),
        });

        const done = hydrateThenReveal(s);

        // Hydration is still pending: nothing may have run yet, and markReady in particular must
        // not have fired - that is the whole rule this file exists to pin.
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).not.toContain('markReady');

        resolveHydrate(3);
        await done;

        expect(calls).toContain('markReady');
        expect(calls.indexOf('markReady')).toBe(calls.length - 1);
    });

    it('revalidates and marks ready once hydration reports profiles were loaded', async () => {
        const {calls, steps: s} = steps();

        await hydrateThenReveal(s);

        expect(calls).toEqual(['hydrate', 'revalidateAll', 'markReady']);
    });

    it('skips revalidation when nothing was hydrated, but still marks ready', async () => {
        const {calls, steps: s} = steps({
            hydrate: async () => {
                calls.push('hydrate');
                return 0;
            },
        });

        await hydrateThenReveal(s);

        expect(calls).toEqual(['hydrate', 'markReady']);
    });

    it('a rejected hydration still results in markReady being called', async () => {
        const {calls, steps: s} = steps({
            hydrate: async () => {
                calls.push('hydrate');
                throw new Error('no sealing key');
            },
        });

        // Must not throw: a cache fault degrades to the cold start that shipped before the cache
        // existed, it does not hang or fail the launch.
        await expect(hydrateThenReveal(s)).resolves.toBeUndefined();

        expect(calls).toEqual(['hydrate', 'markReady']);
    });
});
