/**
 * Which shell this bundle is running in.
 *
 * <p>One bundle serves both hosts - there is no second Angular build target - so this is a runtime
 * answer, not a compile-time one. See `docs/superpowers/specs/2026-08-11-browser-only-build-design.md`.</p>
 */
export type PlatformHost = 'tauri' | 'web';

/**
 * Whether a Tauri runtime is present.
 *
 * <p><b>This is the only place in the app that reads the Tauri global.</b> Everything else asks
 * {@link detectHost} or, better, reads a flag off `PlatformCapabilities` - because "is this Tauri"
 * is almost never the question a caller actually has. The questions callers have are "can I bind a
 * global hotkey" and "are these keys OS-protected", and those are capabilities, not hosts.</p>
 *
 * <p>`typeof window === 'undefined'` is guarded rather than assumed: this runs in specs under a
 * runner that may have no DOM at all, and a bare `in window` there throws a `ReferenceError` during
 * module evaluation - which fails the whole file rather than one assertion.</p>
 *
 * <p>Read per call rather than memoised at module scope. The Tauri runtime injects
 * `__TAURI_INTERNALS__` before any application script evaluates, so the answer cannot change within
 * a session and there is nothing to cache; leaving it a live read is what lets a test define the
 * global and get the branch it asked for.</p>
 */
export function detectHost(): PlatformHost {
    if (typeof window === 'undefined') return 'web';
    return '__TAURI_INTERNALS__' in window ? 'tauri' : 'web';
}
