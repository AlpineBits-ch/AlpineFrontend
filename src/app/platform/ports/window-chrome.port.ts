/**
 * Which edge or corner a resize drag started from. Matches Tauri's `ResizeDirection`.
 */
export type ResizeDirection =
    | 'North' | 'East' | 'South' | 'West'
    | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

/**
 * The window frame the app draws for itself. Desktop-only.
 *
 * On web these controls are hidden rather than disabled.
 */
export abstract class WindowChrome {
    /** False on web. Callers hide their controls rather than disabling them. */
    abstract readonly supported: boolean;

    /** Whether the window sits flush to the screen edges, maximised or fullscreen. False on web. */
    abstract isFlush(): Promise<boolean>;

    /** Fires on maximize, restore and fullscreen alike - all three resize the window. */
    abstract onResized(handler: () => void): Promise<() => void>;

    /**
     * Fires when the user asks to close the window, before it goes. Registering takes ownership of
     * the close, so an adapter must never let a handler reject.
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
