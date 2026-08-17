import {formatAccelerator} from '../accelerator';
import {NativePttCapture, NativePttEdge, NativePttHook} from '../hotkeys-native';
import {Hotkeys, HotkeyHandlers} from '../ports/hotkeys.port';

/** One live registration. `isDown` is the whole reason this map exists - see {@link TauriHotkeys}. */
interface Binding {
    accelerator: string;
    handlers: HotkeyHandlers;
    /** Debounces OS key-repeat so onDown/onUp fire only on real transitions. */
    isDown: boolean;
}

/**
 * Hotkeys on the desktop: OS-registered accelerators, plus the Windows low-level PTT hook.
 *
 * <p>Both booleans are true. These fire while another application has focus, which is the case
 * push-to-talk exists for.</p>
 *
 * <p>The key-repeat debounce is carried over from `HotkeyService` unchanged and is not optional: the OS
 * repeats a held key, the plugin reports every repeat as another `Pressed`, and a caller that took
 * those at face value would machine-gun `onDown` for as long as the key is held. The `isDown` flag
 * turns that stream back into two edges.</p>
 *
 * <p>The plugin is imported lazily, per call, so the browser bundle never pulls it: this class is
 * statically reachable from `provide-platform.ts` (a DI factory cannot await) but the only thing that
 * costs is this file, and the `import()` below is a chunk the web host never asks for.</p>
 */
export class TauriHotkeys extends Hotkeys implements NativePttHook {
    readonly global = true;
    readonly focused = true;

    private readonly bindings = new Map<string, Binding>();
    /** `ptt_supported`, asked once. The answer cannot change within a process. */
    private hookSupported: Promise<boolean> | null = null;
    private edgeSubscribed = false;
    private captureSubscribed = false;

    async bind(id: string, accelerator: string, handlers: HotkeyHandlers): Promise<boolean> {
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
            return true;
        } catch (err) {
            // Another process already owns the accelerator, or the plugin is not present. Reported as
            // false rather than only logged: the port's contract is that the caller can tell.
            console.error(`[hotkey] failed to register '${accelerator}' for '${id}':`, err);
            this.bindings.delete(id);
            return false;
        }
    }

    async unbind(id: string): Promise<void> {
        const binding = this.bindings.get(id);
        if (!binding) return;
        this.bindings.delete(id);

        // A binding that was held down when it was dropped still owes its release: the caller's gate
        // is a boolean it set on `onDown`, and nothing else will ever clear it.
        if (binding.isDown) {
            binding.isDown = false;
            binding.handlers.onUp?.();
        }

        try {
            const {unregister} = await import('@tauri-apps/plugin-global-shortcut');
            await unregister(binding.accelerator);
        } catch (err) {
            console.warn(`[hotkey] failed to unregister '${binding.accelerator}':`, err);
        }
    }

    /**
     * The hook's own label where the hook exists, a formatted accelerator otherwise.
     *
     * <p>Not unconditionally `ptt_label`: on a non-Windows desktop build that command returns its
     * argument untouched (`ptt_hook.rs`'s non-Windows `imp::label`), so asking it would turn
     * `Ctrl + Shift + V` back into `Control+Shift+KeyV` on macOS. This is the branch
     * `NativePttService.labelFor` has always taken, moved down here.</p>
     */
    async label(accelerator: string): Promise<string> {
        if (await this.pttSupported()) {
            try {
                return await this.pttLabel(accelerator);
            } catch {
                // Fall through - a formatted accelerator beats showing a raw token.
            }
        }
        return formatAccelerator(accelerator);
    }

    /**
     * Capture through the native hook, which is the only thing that can see a mouse button.
     *
     * <p>`id` is a slot number here. The port names no channel for the captured value; on this host it
     * arrives as the `ptt-capture` event, which {@link onPttCapture} delivers.</p>
     */
    async beginCapture(id: string): Promise<void> {
        await this.pttBeginCapture(Number(id));
    }

    async cancelCapture(): Promise<void> {
        await this.pttCancelCapture();
    }

    // ── NativePttHook ────────────────────────────────────────────────────────

    pttSupported(): Promise<boolean> {
        this.hookSupported ??= this.invoke<boolean>('ptt_supported').catch(err => {
            console.error('[hotkey] ptt_supported failed', err);
            return false;
        });
        return this.hookSupported;
    }

    async pttSetBinding(slot: number, token: string): Promise<void> {
        await this.invoke('ptt_set_binding', {slot, token});
    }

    async pttArm(slot: number): Promise<void> {
        await this.invoke('ptt_arm', {slot});
    }

    async pttDisarm(slot: number): Promise<void> {
        await this.invoke('ptt_disarm', {slot});
    }

    async pttBeginCapture(slot: number): Promise<void> {
        await this.invoke('ptt_begin_capture', {slot});
    }

    async pttCancelCapture(): Promise<void> {
        await this.invoke('ptt_cancel_capture');
    }

    pttLabel(token: string): Promise<string> {
        return this.invoke<string>('ptt_label', {token});
    }

    async onPttEdge(handler: (edge: NativePttEdge) => void): Promise<void> {
        if (this.edgeSubscribed) return;
        this.edgeSubscribed = true;
        const {listen} = await import('@tauri-apps/api/event');
        await listen<{slot: number}>('ptt-down', e => handler({slot: e.payload.slot, down: true}));
        await listen<{slot: number}>('ptt-up', e => handler({slot: e.payload.slot, down: false}));
    }

    async onPttCapture(handler: (result: NativePttCapture) => void): Promise<void> {
        if (this.captureSubscribed) return;
        this.captureSubscribed = true;
        const {listen} = await import('@tauri-apps/api/event');
        await listen<NativePttCapture>('ptt-capture', e => handler(e.payload));
    }

    private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<T>(cmd, args);
    }
}
