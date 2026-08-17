import {describe, expect, it} from 'vitest';
import {hydrateThenReveal, ProfileCacheHydrationSteps, revealAfterAccountGateBlock} from './profile-cache-hydration';

/**
 * Pins the ordering rule `MainPageComponent.runDeviceLaunch` relies on: hydration must finish
 * before the splash comes down, and a hydration fault must never be able to hold the splash up.
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

/**
 * Pins the fix for the email-verification path: `EmailVerificationDialogComponent` is a
 * translucent PrimeNG mask over the still-rendered main-page shell (the onboarding picker's
 * `fixed inset-0 bg-app-bg` takeover is opaque and is not this hazard), and `main-page.component
 * .html` is not gated on readiness - so a returning user with a restored `mainView` can see the
 * server rail, sidebar and `GuildMemberListComponent`'s raw-id fallback dimmed behind the mask
 * before hydration has populated the profile map. Asserted against
 * {@link revealAfterAccountGateBlock} itself - the exact function `initLaunchSequence` calls.
 */
describe('revealAfterAccountGateBlock', () => {
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

    it('marks ready without hydrating for the opaque onboarding takeover', async () => {
        const {calls, steps: s} = steps();

        await revealAfterAccountGateBlock('onboarding', s);

        // Nothing behind the picker is visible, so there is nothing hydration could fix that the
        // user could see - hydrate must not even be called.
        expect(calls).toEqual(['markReady']);
    });

    it('does not mark ready until hydration resolves on the email-verification path', async () => {
        let resolveHydrate!: (count: number) => void;
        const {calls, steps: s} = steps({
            hydrate: () => new Promise<number>(resolve => {
                resolveHydrate = resolve;
            }),
        });

        const done = revealAfterAccountGateBlock('email-verification', s);

        // Hydration is still pending: the dialog's mask is translucent, so markReady must not fire
        // while the shell behind it could still be showing raw ids.
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).not.toContain('markReady');

        resolveHydrate(3);
        await done;

        expect(calls).toContain('markReady');
        expect(calls.indexOf('markReady')).toBe(calls.length - 1);
    });

    it('a rejected hydration still reveals the email-verification path', async () => {
        const {calls, steps: s} = steps({
            hydrate: async () => {
                calls.push('hydrate');
                throw new Error('no sealing key');
            },
        });

        await expect(revealAfterAccountGateBlock('email-verification', s)).resolves.toBeUndefined();

        expect(calls).toEqual(['hydrate', 'markReady']);
    });

    /**
     * The 403 branch of `resolveAccountGates` returns `'email-verification'` before
     * `establishAccountSlot(user)` has run, so `DeviceIdentityService.deviceId()` still answers
     * `BOOTSTRAP_SLOT_ID`. Hydrating there reads a namespace that cannot hold this account's data -
     * and installs the write-behind hook, so everything the session goes on to resolve is written
     * under an id `SessionTeardownService.wipeEngineState(deviceId)` is never given.
     */
    it('does not hydrate the email-verification path when no account slot is live', async () => {
        const {calls, steps: s} = steps();

        await revealAfterAccountGateBlock('email-verification', s, async () => false);

        expect(calls).toEqual(['markReady']);
    });

    it('still hydrates the email-verification path when a slot is live', async () => {
        const {calls, steps: s} = steps();

        await revealAfterAccountGateBlock('email-verification', s, async () => true);

        expect(calls).toEqual(['hydrate', 'revalidateAll', 'markReady']);
    });

    it('treats an unanswerable slot lookup as no slot, and still reveals', async () => {
        const {calls, steps: s} = steps();

        await revealAfterAccountGateBlock(
            'email-verification', s, () => Promise.reject(new Error('registry unreadable')));

        expect(calls).toEqual(['markReady']);
    });
});
