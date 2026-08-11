import {Hotkeys} from './ports/hotkeys.port';

/**
 * The Windows low-level push-to-talk hook: a **desktop-only superset** of {@link Hotkeys}.
 *
 * <p>The `Hotkeys` port is what every host can answer - bind, unbind, label, capture. The native hook
 * is more than that and less portable: it addresses a fixed set of slots, it can bind a bare modifier
 * or a mouse button, and it only ever *observes* keystrokes rather than registering them, which is why
 * `call-hotkey.service.ts` prefers it over `RegisterHotKey` accelerators. None of that generalises to
 * a browser, so it is declared here as an optional extension the Tauri adapter implements and the web
 * adapter does not, rather than widened into the port - the port's shape is normative in
 * `docs/superpowers/specs/2026-08-11-browser-only-build-design.md` and a browser would have to answer
 * seven methods with a throw.</p>
 *
 * <p>{@link asNativePttHook} is how a caller finds out. It is a runtime check rather than a
 * `host === 'tauri'` test on purpose: presence of the hook and presence of Tauri are not the same
 * question - `ptt_supported()` is false on macOS and Linux desktop builds too - so the shape is
 * probed and then the command is asked.</p>
 */
export interface NativePttHook {
    /** `ptt_supported`: whether the hook is installed at all (Windows only). */
    pttSupported(): Promise<boolean>;

    /** `ptt_set_binding`: point one slot at a token (`Ctrl`, `KeyV`, `MouseX2`, `VK86`, …). */
    pttSetBinding(slot: number, token: string): Promise<void>;

    /** `ptt_arm`: start delivering edges for a slot. */
    pttArm(slot: number): Promise<void>;

    /** `ptt_disarm`: stop delivering edges for a slot. */
    pttDisarm(slot: number): Promise<void>;

    /** `ptt_begin_capture`: read the next input the user gives, for the keybinds page. */
    pttBeginCapture(slot: number): Promise<void>;

    /** `ptt_cancel_capture`: leave capture mode, resetting the hook's capturing flag. */
    pttCancelCapture(): Promise<void>;

    /** `ptt_label`: the hook's own formatting of one of its tokens. */
    pttLabel(token: string): Promise<string>;

    /** Subscribe to `ptt-down` / `ptt-up`. Idempotent per adapter instance. */
    onPttEdge(handler: (edge: NativePttEdge) => void): Promise<void>;

    /** Subscribe to `ptt-capture`, the result of {@link pttBeginCapture}. */
    onPttCapture(handler: (result: NativePttCapture) => void): Promise<void>;
}

/** One down/up transition, tagged with the slot that produced it. */
export interface NativePttEdge {
    slot: number;
    down: boolean;
}

/** What the hook captured, or `cancelled` if the user backed out. */
export interface NativePttCapture {
    slot: number;
    token: string;
    label: string;
    cancelled: boolean;
}

/** Method names that together mean "this adapter really is the native hook". */
const HOOK_METHODS: readonly (keyof NativePttHook)[] = [
    'pttSupported', 'pttSetBinding', 'pttArm', 'pttDisarm',
    'pttBeginCapture', 'pttCancelCapture', 'pttLabel', 'onPttEdge', 'onPttCapture',
];

/**
 * The injected {@link Hotkeys} adapter as a native hook, or null when it is not one.
 *
 * <p>Every method is checked rather than one of them: a half-implemented adapter should fail at the
 * boundary with "there is no hook here", not at the third call.</p>
 */
export function asNativePttHook(hotkeys: Hotkeys): NativePttHook | null {
    const candidate = hotkeys as unknown as Record<string, unknown>;
    const complete = HOOK_METHODS.every(method => typeof candidate[method] === 'function');
    return complete ? (hotkeys as unknown as NativePttHook) : null;
}
