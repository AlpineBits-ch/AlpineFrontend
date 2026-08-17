import {Hotkeys} from './ports/hotkeys.port';

/**
 * The Windows low-level push-to-talk hook: a desktop-only superset of {@link Hotkeys}.
 *
 * An optional extension the Tauri adapter implements and the web adapter does not.
 * {@link asNativePttHook} probes for it at runtime, not on `host === 'tauri'`: `ptt_supported()` is
 * false on macOS and Linux desktop builds too.
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
    'pttSupported',
    'pttSetBinding',
    'pttArm',
    'pttDisarm',
    'pttBeginCapture',
    'pttCancelCapture',
    'pttLabel',
    'onPttEdge',
    'onPttCapture',
];

/**
 * The injected {@link Hotkeys} adapter as a native hook, or null when it is not one.
 *
 * Every method must stay checked, so a half-implemented adapter fails here and not at the third call.
 */
export function asNativePttHook(hotkeys: Hotkeys): NativePttHook | null {
    const candidate = hotkeys as unknown as Record<string, unknown>;
    const complete = HOOK_METHODS.every(method => typeof candidate[method] === 'function');
    return complete ? (hotkeys as unknown as NativePttHook) : null;
}
