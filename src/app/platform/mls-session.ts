import {MlsEngine} from './ports/mls-engine.port';

/**
 * The browser engine's one extra fact: this tab has just been handed the account's engine.
 *
 * A web-only superset of {@link MlsEngine}. The adapter reports the grant and `MainPageComponent`
 * answers it by running the device launch again; restoring the engine without re-running the launch
 * leaves the tab stuck on "encryption unavailable".
 */
export interface MlsSessionTakeover {
    /**
     * Calls `listener` when this tab is granted an account scope it was previously refused.
     *
     * Only for a grant that was waiting: reporting the first claim runs the launch twice on a cold start.
     *
     * @returns a function that stops the listener being called.
     */
    onSessionTakeover(listener: () => void): () => void;
}

/**
 * The injected {@link MlsEngine} as a takeover reporter, or null where the host has no such thing.
 *
 * A shape probe, not a `host === 'web'` test.
 */
export function asMlsSessionTakeover(engine: MlsEngine): MlsSessionTakeover | null {
    const candidate = engine as unknown as Record<string, unknown>;
    return typeof candidate['onSessionTakeover'] === 'function'
        ? (engine as unknown as MlsSessionTakeover)
        : null;
}
