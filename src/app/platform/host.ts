/** Which shell this bundle is running in. One bundle serves both, so this is a runtime answer. */
export type PlatformHost = 'tauri' | 'web';

/**
 * Whether a Tauri runtime is present.
 *
 * The only place in the app that may read the Tauri global. Must stay a per-call read, not a
 * module-scope memo, so a test can define the global and get the branch it asked for.
 */
export function detectHost(): PlatformHost {
    if (typeof window === 'undefined') return 'web';
    return '__TAURI_INTERNALS__' in window ? 'tauri' : 'web';
}
