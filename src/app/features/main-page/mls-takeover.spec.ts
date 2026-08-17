import {Subject} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {relaunchOnSessionTakeover} from './mls-takeover';

/** What happens after a browser tab is handed the account's encryption engine. */
describe('relaunchOnSessionTakeover', () => {
    it('runs the launch again when the tab is handed the engine', async () => {
        const takeovers = new Subject<void>();
        const relaunch = vi.fn(async () => undefined);
        relaunchOnSessionTakeover({takeovers: () => takeovers, relaunch, log: () => undefined});

        takeovers.next();

        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it('does nothing until there is a takeover', () => {
        const relaunch = vi.fn(async () => undefined);
        relaunchOnSessionTakeover({
            takeovers: () => new Subject<void>(),
            relaunch,
            log: () => undefined,
        });

        // Subscribing must not itself relaunch: this runs in the component's constructor, beside the
        // launch it would be duplicating.
        expect(relaunch).not.toHaveBeenCalled();
    });

    it('answers a second takeover as well, because an account switch is another one', () => {
        const takeovers = new Subject<void>();
        const relaunch = vi.fn(async () => undefined);
        relaunchOnSessionTakeover({takeovers: () => takeovers, relaunch, log: () => undefined});

        takeovers.next();
        takeovers.next();

        expect(relaunch).toHaveBeenCalledTimes(2);
    });

    it('survives a launch that rejects, and still answers the next takeover', async () => {
        const takeovers = new Subject<void>();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const relaunch = vi
            .fn()
            .mockRejectedValueOnce(new Error('the key store is locked'))
            .mockResolvedValueOnce(undefined);
        relaunchOnSessionTakeover({takeovers: () => takeovers, relaunch, log: () => undefined});

        try {
            takeovers.next();
            // An unhandled rejection here would tear the subscription down and leave every later
            // takeover with nothing listening - a failure that only shows up on the second one.
            await Promise.resolve();
            await Promise.resolve();
            takeovers.next();

            expect(relaunch).toHaveBeenCalledTimes(2);
        } finally {
            error.mockRestore();
        }
    });

    it('records the takeover, because a relaunch is otherwise invisible in the log', () => {
        const takeovers = new Subject<void>();
        const lines: string[] = [];
        relaunchOnSessionTakeover({
            takeovers: () => takeovers,
            relaunch: async () => undefined,
            log: message => lines.push(message),
        });

        takeovers.next();

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('closing tab');
    });

    it('stops relaunching once the subscription is closed', () => {
        const takeovers = new Subject<void>();
        const relaunch = vi.fn(async () => undefined);
        const subscription = relaunchOnSessionTakeover({
            takeovers: () => takeovers,
            relaunch,
            log: () => undefined,
        });

        subscription.unsubscribe();
        takeovers.next();

        expect(relaunch).not.toHaveBeenCalled();
    });
});
