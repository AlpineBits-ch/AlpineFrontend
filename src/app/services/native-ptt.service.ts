import {Injectable, signal} from '@angular/core';
import {isTauri} from '@tauri-apps/api/core';
import {filter, firstValueFrom, map, Observable, Subject} from 'rxjs';

/**
 * Frontend bridge to the native low-level push-to-talk hook (Windows).
 *
 * Unlike the global-shortcut plugin, the native hook can bind a bare modifier
 * (Ctrl) or a mouse button and works while the game -not Echo -is focused.
 * On non-Windows targets `supported()` is false and callers fall back to
 * {@link HotkeyService}.
 *
 * The hook holds a fixed number of independent slots (see `ptt_hook.rs`), so
 * more than one native binding can be armed at once - e.g. a hold-to-talk key
 * and a separate push-to-mute key. Every method below takes the slot it
 * addresses; callers own the mapping from a {@link KeybindActionId} to a slot.
 */

export interface PttCaptureResult {
    slot: number;
    token: string;
    label: string;
    cancelled: boolean;
}

export interface PttEdge {
    slot: number;
    down: boolean;
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
    /** Emits every down/up edge, tagged with the slot that fired. */
    readonly transmit$ = new Subject<PttEdge>();

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

    /** Edges for one slot only - what most callers actually want. */
    edgesFor(slot: number): Observable<boolean> {
        return this.transmit$.pipe(filter(e => e.slot === slot), map(e => e.down));
    }

    async setBinding(slot: number, token: string): Promise<void> {
        await this.invoke('ptt_set_binding', {slot, token});
    }

    async arm(slot: number): Promise<void> {
        await this.invoke('ptt_arm', {slot});
    }

    async disarm(slot: number): Promise<void> {
        await this.invoke('ptt_disarm', {slot});
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

    /** Enter capture mode for a slot; resolves with the next bound input (or a cancelled result). */
    async beginCapture(slot: number): Promise<PttCaptureResult> {
        const result = firstValueFrom(this.capture$);
        await this.invoke('ptt_begin_capture', {slot});
        return result;
    }

    private async init(): Promise<void> {
        try {
            const ok = await this.invoke<boolean>('ptt_supported');
            this.supportedSig.set(ok);
            if (!ok) return;
            const {listen} = await import('@tauri-apps/api/event');
            await listen<{ slot: number }>('ptt-down', e => this.transmit$.next({slot: e.payload.slot, down: true}));
            await listen<{ slot: number }>('ptt-up', e => this.transmit$.next({slot: e.payload.slot, down: false}));
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
