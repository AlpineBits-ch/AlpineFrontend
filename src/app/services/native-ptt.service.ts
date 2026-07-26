import {Injectable, signal} from '@angular/core';
import {isTauri} from '@tauri-apps/api/core';
import {firstValueFrom, Subject} from 'rxjs';

/**
 * Frontend bridge to the native low-level push-to-talk hook (Windows).
 *
 * Unlike the global-shortcut plugin, the native hook can bind a bare modifier
 * (Ctrl) or a mouse button and works while the game -not Echo -is focused.
 * On non-Windows targets `supported()` is false and callers fall back to
 * {@link HotkeyService}.
 */

export interface PttCaptureResult {
    token: string;
    label: string;
    cancelled: boolean;
}

/**
 * Human-readable form of a Tauri global-shortcut accelerator (e.g.
 * `Control+Shift+KeyV` → `Ctrl + Shift + V`). Only for the non-native fallback:
 * native tokens (`VK86`, `MouseX2`) are formatted in Rust by `ptt_label`.
 */
export function formatAccelerator(accelerator: string): string {
    return accelerator.split('+').map(part => {
        switch (part) {
            case 'Control':
                return 'Ctrl';
            case 'Super':
                return 'Win';
            case 'Backquote':
                return '`';
            default:
                if (part.startsWith('Key')) return part.slice(3);
                if (part.startsWith('Digit')) return part.slice(5);
                return part;
        }
    }).join(' + ');
}

@Injectable({providedIn: 'root'})
export class NativePttService {
    /** Emits true on key-down (transmit) and false on key-up. */
    readonly transmit$ = new Subject<boolean>();

    private readonly capture$ = new Subject<PttCaptureResult>();
    private readonly supportedSig = signal(false);
    readonly supported = this.supportedSig.asReadonly();
    private ready: Promise<void> | null = null;

    constructor() {
        if (isTauri()) this.ready = this.init();
    }

    /** Resolves once support has been probed and listeners are attached. */
    async whenReady(): Promise<void> {
        if (this.ready) await this.ready;
    }

    async setBinding(token: string): Promise<void> {
        await this.invoke('ptt_set_binding', {token});
    }

    async arm(): Promise<void> {
        await this.invoke('ptt_arm');
    }

    async disarm(): Promise<void> {
        await this.invoke('ptt_disarm');
    }

    async cancelCapture(): Promise<void> {
        await this.invoke('ptt_cancel_capture');
    }

    async label(token: string): Promise<string> {
        return this.invoke<string>('ptt_label', {token});
    }

    /**
     * Display label for a stored binding, whichever mechanism is in play: the
     * native hook formats its own tokens, everything else is an accelerator.
     */
    async labelFor(token: string): Promise<string> {
        await this.whenReady();
        if (this.supportedSig()) {
            try {
                return await this.label(token);
            } catch {
                // Fall through -a formatted accelerator beats showing a raw token.
            }
        }
        return formatAccelerator(token);
    }

    /** Enter capture mode; resolves with the next bound input (or a cancelled result). */
    async beginCapture(): Promise<PttCaptureResult> {
        const result = firstValueFrom(this.capture$);
        await this.invoke('ptt_begin_capture');
        return result;
    }

    private async init(): Promise<void> {
        try {
            const ok = await this.invoke<boolean>('ptt_supported');
            this.supportedSig.set(ok);
            if (!ok) return;
            const {listen} = await import('@tauri-apps/api/event');
            await listen('ptt-down', () => this.transmit$.next(true));
            await listen('ptt-up', () => this.transmit$.next(false));
            await listen<PttCaptureResult>('ptt-capture', e => this.capture$.next(e.payload));
        } catch (err) {
            console.error('[native-ptt] init failed', err);
        }
    }

    private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<T>(cmd, args);
    }
}
