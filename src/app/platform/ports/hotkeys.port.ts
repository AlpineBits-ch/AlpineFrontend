/**
 * What a bound key is expected to do. Both edges, because push-to-talk needs the release as much as
 * the press.
 */
export interface HotkeyHandlers {
    onDown?(): void;

    onUp?(): void;
}

/**
 * Key bindings, and an honest answer about how far they reach.
 *
 * The two booleans are the point: `global = false` is what makes the UI offer voice activity
 * detection instead of a keybind that would register and never fire.
 */
export abstract class Hotkeys {
    /** False on web: no API fires while the tab is unfocused. */
    abstract readonly global: boolean;
    /** True on web: keydown works, but only while focused. */
    abstract readonly focused: boolean;

    /**
     * Register (or re-register) `accelerator` under a logical `id`, replacing whatever that id held.
     *
     * Returns false when the binding could not be taken. Must never swallow that into a resolve.
     */
    abstract bind(id: string, accelerator: string, h: HotkeyHandlers): Promise<boolean>;

    abstract unbind(id: string): Promise<void>;

    /** The accelerator as a human would read it, for the keybinds page. */
    abstract label(accelerator: string): Promise<string>;

    /**
     * Start listening for the next key the user presses, on behalf of the keybinds page.
     *
     * How the captured accelerator reaches the caller is not part of this signature; the adapter
     * writes it through to `KeybindsService`.
     */
    abstract beginCapture(id: string): Promise<void>;

    abstract cancelCapture(): Promise<void>;
}
