import {MlsEngine} from './ports/mls-engine.port';

/**
 * The browser engine's one extra fact: <b>this tab has just been handed the account's engine</b>.
 *
 * <p>A **web-only superset** of {@link MlsEngine}, declared here rather than widened into the port for
 * the reason `hotkeys-native.ts` gives about the native PTT hook: the port is host-neutral, and a host
 * with one process has nothing to report. There is exactly one engine on the desktop and it is this
 * one's from the moment the app starts, so a takeover is not a late answer there - it is not a
 * question.</p>
 *
 * <h3>What goes wrong without it</h3>
 *
 * <p>`WebMlsEngine` holds an exclusive Web Lock per account scope and a second tab that cannot get it
 * refuses every engine command, leaving a queued request behind. When the owning tab closes, the
 * browser grants that request and the adapter is whole again: the next command notices, restores the
 * blob the other tab left, and proceeds. <b>Nothing issues that next command.</b> The launch sequence
 * ran once, at boot, and every MLS step in it failed against the refusal - `autoUnlock` produced no key
 * handle, the pending Welcomes were never processed, no key packages were uploaded - so the tab sits on
 * "encryption unavailable" indefinitely, with a perfectly good engine underneath it, until somebody
 * reloads the page. Restoring the engine and never re-running the launch that depends on it is half a
 * takeover.</p>
 *
 * <p>So the adapter reports the grant and `MainPageComponent` answers it by running the device launch
 * again, which is the same thing the onboarding picker does when it resumes a suspended launch.</p>
 */
export interface MlsSessionTakeover {
    /**
     * Calls `listener` when this tab is granted an account scope it was previously refused.
     *
     * <p>Only for a grant that was waiting: the first claim on the boot path is not a takeover, and
     * reporting it would run the launch sequence twice on every cold start.</p>
     *
     * @returns a function that stops the listener being called.
     */
    onSessionTakeover(listener: () => void): () => void;
}

/**
 * The injected {@link MlsEngine} as a takeover reporter, or null where the host has no such thing.
 *
 * <p>A shape probe rather than a `host === 'web'` test, for the reason `asNativePttHook` is: the two
 * questions are not the same one, and a caller should ask the adapter what it can do rather than infer
 * it from where it is running.</p>
 */
export function asMlsSessionTakeover(engine: MlsEngine): MlsSessionTakeover | null {
    const candidate = engine as unknown as Record<string, unknown>;
    return typeof candidate['onSessionTakeover'] === 'function'
        ? (engine as unknown as MlsSessionTakeover)
        : null;
}
