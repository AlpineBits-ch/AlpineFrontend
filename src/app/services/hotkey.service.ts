import {Injectable} from '@angular/core';
import {isTauri} from '@tauri-apps/api/core';

/**
 * Generic OS-level global hotkey foundation, backed by the Tauri global-shortcut
 * plugin. Unlike DOM `keydown`, these fire even when the app window is NOT focused
 * -required for push-to-talk while the game (not Echo) has focus.
 *
 * A registered accelerator is captured OS-wide, so bindings should only be held
 * while actually needed (e.g. while proximity voice is connected).
 *
 * v1 binds one action (Isle PTT); the `bind`/`unbind` surface is deliberately
 * generic so future actions (push-to-mute, global PTT) reuse it unchanged.
 */

export interface HotkeyHandlers {
    /** Fired once on the leading edge (key pressed). */
    onDown?: () => void;
    /** Fired once on the trailing edge (key released). */
    onUp?: () => void;
}

interface Binding {
    accelerator: string;
    handlers: HotkeyHandlers;
    /** Debounces OS key-repeat so onDown/onUp fire only on real transitions. */
    isDown: boolean;
}

@Injectable({providedIn: 'root'})
export class HotkeyService {
    private readonly bindings = new Map<string, Binding>();

    get supported(): boolean {
        return isTauri();
    }

    /**
     * Register (or re-register) a global hotkey under a logical `id`. Re-binding the
     * same id transparently unregisters the previous accelerator first.
     */
    async bind(id: string, accelerator: string, handlers: HotkeyHandlers): Promise<void> {
        if (!this.supported) return;
        await this.unbind(id);

        const binding: Binding = {accelerator, handlers, isDown: false};
        this.bindings.set(id, binding);

        try {
            const {register} = await import('@tauri-apps/plugin-global-shortcut');
            await register(accelerator, event => {
                const b = this.bindings.get(id);
                if (!b) return;
                if (event.state === 'Pressed') {
                    if (b.isDown) return; // ignore auto-repeat
                    b.isDown = true;
                    b.handlers.onDown?.();
                } else {
                    if (!b.isDown) return;
                    b.isDown = false;
                    b.handlers.onUp?.();
                }
            });
        } catch (err) {
            console.error(`[hotkey] failed to register '${accelerator}' for '${id}':`, err);
            this.bindings.delete(id);
        }
    }

    async unbind(id: string): Promise<void> {
        const binding = this.bindings.get(id);
        if (!binding) return;
        this.bindings.delete(id);
        if (!this.supported) return;
        try {
            const {unregister} = await import('@tauri-apps/plugin-global-shortcut');
            await unregister(binding.accelerator);
        } catch (err) {
            console.warn(`[hotkey] failed to unregister '${binding.accelerator}':`, err);
        }
    }
}
