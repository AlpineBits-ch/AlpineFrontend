/**
 * Which edge or corner a resize drag started from. Matches Tauri's `ResizeDirection`.
 */
export type ResizeDirection =
    | 'North' | 'East' | 'South' | 'West'
    | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

/**
 * The window frame the app draws for itself.
 *
 * <p><b>Desktop-only.</b> A browser tab has no frame to own, so the web adapter reports
 * `supported = false` and every method is a no-op. The rule from the design spec is that these
 * controls are *hidden* rather than disabled - a greyed-out minimise button in a browser needs
 * explaining, and its absence does not.</p>
 *
 * <p>The design spec names this port without giving its signature, so the surface below is taken
 * from what already calls into `@tauri-apps/api/window`: `WindowChromeService` (flush corners and
 * dragging an overlaid titlebar), `TitlebarComponent` (the three buttons and the maximised state)
 * and `ResizeHandlesComponent`.</p>
 */
export abstract class WindowChrome {
    /** False on web. Callers hide their controls rather than disabling them. */
    abstract readonly supported: boolean;

    /**
     * Whether the window sits flush to the screen edges, by either route.
     *
     * <p>Maximised or fullscreen, folded into one answer because the consequence is the same: the
     * app's own rounded corners have to come off, or the desktop shows through four notches. Always
     * false on web.</p>
     */
    abstract isFlush(): Promise<boolean>;

    /** Fires on maximize, restore and fullscreen alike - all three resize the window. */
    abstract onResized(handler: () => void): Promise<() => void>;

    /**
     * Fires when the user asks to close the window, before it goes.
     *
     * <p><b>Registering this takes ownership of the close.</b> Tauri calls `prevent_close()` for any
     * window with a JS `tauri://close-requested` listener and then relies on the wrapper to destroy
     * it once every handler resolves - so a handler that throws leaves a window the user cannot shut.
     * Adapters must never let one reject.</p>
     */
    abstract onCloseRequested(handler: () => void): Promise<() => void>;

    abstract minimize(): Promise<void>;

    abstract toggleMaximize(): Promise<void>;

    abstract isMaximized(): Promise<boolean>;

    abstract close(): Promise<void>;

    /** Begin a move drag. Used for presses the native drag region cannot see, e.g. under a modal mask. */
    abstract startDragging(): Promise<void>;

    abstract startResizeDragging(direction: ResizeDirection): Promise<void>;
}
