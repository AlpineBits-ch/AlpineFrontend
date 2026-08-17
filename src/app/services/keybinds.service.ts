import {Injectable, inject, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {findKeybindAction, KeybindActionDef, KeybindActionId} from '../models/keybind-action.model';
import {formatAccelerator, NativePttService} from './native-ptt.service';

/**
 * Central registry + persistence for every keybindable action (see
 * `keybind-action.model.ts`). Owns the capture UX for the Keybinds settings
 * page; it does NOT own arming/gating a mic - that stays with whichever
 * service actually cares (IsleProximityService, CallHotkeyService), which
 * listen to {@link rebind$} to re-register live when a binding changes.
 */

export type KeybindMap = Partial<Record<KeybindActionId, string>>;

const STORAGE_KEY = 'alpine_keybinds';
/** Pre-Keybinds-page storage, kept around only to migrate existing users once. */
const LEGACY_AUDIO_SETTINGS_KEY = 'alpine_audio_settings';
/** Guards the one-time `*-push-to-mute` → `*-toggle-mute` id rename below. */
const TOGGLE_MUTE_RENAME_FLAG = 'alpine_keybinds_migrated_toggle_mute';

@Injectable({providedIn: 'root'})
export class KeybindsService {
    private nativePtt = inject(NativePttService);

    readonly bindings = signal<KeybindMap>(this.load());
    /** Which action's capture UI is currently open, if any. */
    readonly capturingAction = signal<KeybindActionId | null>(null);

    /** Emits an action id whenever its binding changes (set or cleared). */
    readonly rebind$ = new Subject<KeybindActionId>();

    private acceleratorHandler: ((e: KeyboardEvent) => void) | null = null;
    private nativeCaptureTeardown: (() => void) | null = null;

    /**
     * The token this action answers to right now.
     *
     * Falls back to the action's own default. Only the in-app actions declare one - see
     * `defaultToken` - so this is unchanged for every global hotkey.
     */
    getBinding(id: KeybindActionId): string | null {
        return this.bindings()[id] ?? findKeybindAction(id).defaultToken ?? null;
    }

    /** Human-readable label for the current binding, or a placeholder if unset. */
    async labelFor(id: KeybindActionId): Promise<string> {
        const token = this.getBinding(id);
        if (!token) return 'Unassigned';
        const action = findKeybindAction(id);
        if (action.mechanism === 'native') return this.nativePtt.labelFor(token);
        return formatAccelerator(token);
    }

    setBinding(id: KeybindActionId, token: string | null): void {
        this.bindings.update(map => {
            const next = {...map};
            if (token) next[id] = token; else delete next[id];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            return next;
        });
        this.rebind$.next(id);
    }

    /**
     * Drops the user's override. For an action with a default that is a reset, not an unbind -
     * `getBinding` starts answering with the default again.
     */
    clearBinding(id: KeybindActionId): void {
        if (this.capturingAction() === id) this.cancelCapture();
        this.setBinding(id, null);
    }

    /** Begin interactive capture for one action; only one capture runs at a time. */
    startCapture(id: KeybindActionId): void {
        if (this.capturingAction()) return;
        const action = findKeybindAction(id);
        this.capturingAction.set(id);
        if (action.mechanism === 'native' && this.nativePtt.supported()) {
            void this.captureNative(action);
        } else {
            this.captureAccelerator(action);
        }
    }

    cancelCapture(): void {
        if (!this.capturingAction()) return;
        this.endAcceleratorCapture();
        this.nativeCaptureTeardown?.();
        if (this.nativePtt.supported()) void this.nativePtt.cancelCapture();
        this.capturingAction.set(null);
    }

    // ── Accelerator-only capture (keyboard, OS-registered) ───────────────────
    //
    // Used for actions whose mechanism is 'accelerator' (calls), and as the
    // fallback for 'native' actions on non-Windows targets.

    private captureAccelerator(action: KeybindActionDef): void {
        const handler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') {
                this.endAcceleratorCapture();
                this.capturingAction.set(null);
                return;
            }
            // Wait for a non-modifier key so "Ctrl+…" style combos can be built.
            if (isModifierCode(e.code)) return;
            this.endAcceleratorCapture();
            this.setBinding(action.id, buildAccelerator(e));
            this.capturingAction.set(null);
        };
        this.acceleratorHandler = handler;
        window.addEventListener('keydown', handler, true);
    }

    private endAcceleratorCapture(): void {
        if (this.acceleratorHandler) {
            window.removeEventListener('keydown', this.acceleratorHandler, true);
            this.acceleratorHandler = null;
        }
    }

    // ── Native capture (Windows hook: keyboard, mouse, bare modifier) ────────
    //
    // Races a DOM keyboard capture against the native hook, same idea as the
    // old voice-video-settings implementation: our own window swallows keyboard
    // input before the low-level hook sees it, so keys are read from the DOM
    // while mice buttons -which the hook alone can see cleanly -come from
    // `beginCapture`. Whichever resolves first wins and tears the other down.

    private async captureNative(action: KeybindActionDef): Promise<void> {
        const slot = action.nativeSlot!;
        let done = false;
        let modCandidate: string | null = null;

        const finishKeyboard = (token: string | null): void => {
            if (done) return;
            done = true;
            teardown();
            void this.nativePtt.cancelCapture(); // resets the Rust capturing flag
            if (token) this.setBinding(action.id, token);
            this.capturingAction.set(null);
        };

        const onKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') {
                finishKeyboard(null);
                return;
            }
            if (isModifierCode(e.code)) {
                modCandidate = e.code;
                return;
            }
            if (!isBindableKeyCode(e.code)) return;
            finishKeyboard(buildAccelerator(e));
        };

        const onKeyUp = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (isModifierCode(e.code) && e.code === modCandidate) {
                finishKeyboard(modifierToken(e.code));
            }
        };

        const teardown = () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            this.nativeCaptureTeardown = null;
        };
        this.nativeCaptureTeardown = teardown;
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);

        try {
            const res = await this.nativePtt.beginCapture(slot);
            if (done) return; // keyboard already won
            done = true;
            teardown();
            if (!res.cancelled) this.setBinding(action.id, res.token);
            this.capturingAction.set(null);
        } catch (e) {
            console.error('[keybinds] native capture failed', e);
            if (!done) {
                done = true;
                teardown();
                this.capturingAction.set(null);
            }
        }
    }

    // ── Persistence + one-time legacy migration ──────────────────────────────

    private load(): KeybindMap {
        let map: KeybindMap;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            map = raw ? JSON.parse(raw) as KeybindMap : this.migrateLegacyIsleBinding();
        } catch {
            map = this.migrateLegacyIsleBinding();
        }
        map = this.migrateRenamedToggleMute(map);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
        return map;
    }

    /**
     * Before the Keybinds page existed, Isle proximity had exactly one hotkey
     * whose meaning (push-to-talk vs toggle-mute) was picked with a separate
     * mode switch. Carry that single binding over as whichever of the two
     * actions it used to mean, so existing users don't lose it.
     */
    private migrateLegacyIsleBinding(): KeybindMap {
        try {
            const raw = localStorage.getItem(LEGACY_AUDIO_SETTINGS_KEY);
            if (!raw) return {};
            const old = JSON.parse(raw) as { proximityPttKey?: string; proximityInputMode?: 'ptt' | 'toggle' };
            if (!old.proximityPttKey) return {};
            const id: KeybindActionId = old.proximityInputMode === 'toggle' ? 'isle-toggle-mute' : 'isle-ptt';
            return {[id]: old.proximityPttKey};
        } catch {
            return {};
        }
    }

    /**
     * One-time fixup: `*-push-to-mute` used to mean "press to toggle mute"
     * before Push-to-Mute (hold-to-mute, a distinct action) existed. Anything
     * already bound under the old id meant toggle-mute, so move it to
     * `*-toggle-mute` rather than silently reinterpreting it as hold-to-mute.
     * Guarded so it only ever runs once, letting the (now free) `*-push-to-mute`
     * ids be bound normally afterwards.
     */
    private migrateRenamedToggleMute(map: KeybindMap): KeybindMap {
        if (localStorage.getItem(TOGGLE_MUTE_RENAME_FLAG)) return map;
        localStorage.setItem(TOGGLE_MUTE_RENAME_FLAG, '1');

        const next = {...map};
        const renames: [KeybindActionId, KeybindActionId][] = [
            ['isle-push-to-mute', 'isle-toggle-mute'],
            ['call-push-to-mute', 'call-toggle-mute'],
        ];
        for (const [oldId, newId] of renames) {
            if (next[oldId] && !next[newId]) {
                next[newId] = next[oldId];
                delete next[oldId];
            }
        }
        return next;
    }
}

// ── Keyboard-combo helpers, shared by both capture paths ───────────────────

function isModifierCode(code: string): boolean {
    return code === 'ControlLeft' || code === 'ControlRight'
        || code === 'AltLeft' || code === 'AltRight'
        || code === 'ShiftLeft' || code === 'ShiftRight'
        || code === 'MetaLeft' || code === 'MetaRight';
}

/** True for `KeyboardEvent.code` values the native `code_name_to_vk` can map. */
function isBindableKeyCode(code: string): boolean {
    return /^Key[A-Z]$/.test(code)
        || /^Digit[0-9]$/.test(code)
        || /^F([1-9]|1[0-9]|2[0-4])$/.test(code)
        || code === 'Backquote' || code === 'Space' || code === 'Tab';
}

/** Bare-modifier token for the native hook (matches Rust `parse_token`). */
function modifierToken(code: string): string {
    if (code.startsWith('Control')) return 'Ctrl';
    if (code.startsWith('Alt')) return 'Alt';
    if (code.startsWith('Shift')) return 'Shift';
    return 'Win'; // MetaLeft / MetaRight
}

/** Builds a Tauri global-shortcut accelerator (e.g. "Control+Shift+KeyV") from a keydown. */
function buildAccelerator(e: KeyboardEvent): string {
    return acceleratorFromEvent(e);
}

/**
 * The accelerator a keydown represents, in the one notation this app stores bindings in.
 *
 * Exported because matching has to agree with capture exactly: the in-app actions are dispatched
 * by comparing this against the stored token, and two functions building the string their own way
 * is how a shortcut ends up impossible to trigger but perfectly displayable.
 *
 * `code` rather than `key`: the physical key, so a binding does not move when the layout changes
 * and so Shift combinations stay legible ("Shift+Digit8", not "*").
 */
export function acceleratorFromEvent(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    parts.push(e.code);
    return parts.join('+');
}
