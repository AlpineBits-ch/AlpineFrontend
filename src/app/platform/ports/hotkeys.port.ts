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
 * <p>The two booleans are the point of this port. A browser can observe `keydown` perfectly well -
 * so `focused` is true - but no web API fires while the tab is unfocused, which is precisely the
 * case push-to-talk exists for: the *game* has focus, not the client. Reporting that as
 * `global = false` is what lets the Isle voice UI offer voice activity detection instead of a
 * keybind that would appear to register and never fire. `activity-settings.component.ts` already
 * documents this bug class as the thing to avoid.</p>
 */
export abstract class Hotkeys {
    /** False on web: no API fires while the tab is unfocused. */
    abstract readonly global: boolean;
    /** True on web: keydown works, but only while focused. */
    abstract readonly focused: boolean;

    /**
     * Register (or re-register) `accelerator` under a logical `id`, replacing whatever that id held.
     *
     * <p>Returns false when the binding could not be taken - an accelerator another process already
     * owns, or a host that cannot bind at all. The existing `HotkeyService.bind` swallowed that into
     * a `console.error` and resolved, which is indistinguishable from success at the call site.</p>
     */
    abstract bind(id: string, accelerator: string, h: HotkeyHandlers): Promise<boolean>;

    abstract unbind(id: string): Promise<void>;

    /** The accelerator as a human would read it, for the keybinds page. */
    abstract label(accelerator: string): Promise<string>;

    /**
     * Start listening for the next key the user presses, on behalf of the keybinds page.
     *
     * <p><b>How the captured accelerator reaches the caller is not part of this signature.</b> The
     * design spec gives `beginCapture(id): Promise<void>` and names no result channel; today
     * `KeybindsService` owns both the capture and the store, so the adapter writing through to it is
     * consistent with the current behaviour. Anything that needs the value itself will have to widen
     * this - deliberately left as it stands rather than invented here.</p>
     */
    abstract beginCapture(id: string): Promise<void>;

    abstract cancelCapture(): Promise<void>;
}
