import {inject, Injectable, signal} from '@angular/core';
import {filter, firstValueFrom, map, Observable, Subject} from 'rxjs';
import {formatAccelerator} from '../platform/accelerator';
import {asNativePttHook, NativePttCapture, NativePttEdge, NativePttHook} from '../platform/hotkeys-native';
import {Hotkeys} from '../platform/ports/hotkeys.port';

/**
 * Frontend bridge to the native low-level push-to-talk hook (Windows), as a delegate over the {@link Hotkeys} port.
 * Unlike an OS accelerator it can bind a bare modifier or a mouse button and fires while the game, not Echo, is focused; on web `supported()` is false and callers fall back to {@link HotkeyService}.
 * The hook holds a fixed number of independent slots, so every method below takes the slot it addresses and callers own the action-to-slot mapping.
 */

/** Unchanged shapes, defined once alongside the hook they come from. */
export type PttCaptureResult = NativePttCapture;
export type PttEdge = NativePttEdge;

/** Human-readable form of a global-shortcut accelerator. Only for the non-native fallback: native tokens are formatted in Rust by `ptt_label`. */
export {formatAccelerator};

@Injectable({providedIn: 'root'})
export class NativePttService {
    /** Emits every down/up edge, tagged with the slot that fired. */
    readonly transmit$ = new Subject<PttEdge>();

    private readonly capture$ = new Subject<PttCaptureResult>();
    private readonly supportedSig = signal(false);
    readonly supported = this.supportedSig.asReadonly();
    private ready: Promise<void> | null = null;

    /** The injected adapter if it is the native hook, null in a browser. */
    private readonly hook: NativePttHook | null = asNativePttHook(inject(Hotkeys));

    constructor() {
        if (this.hook) this.ready = this.init(this.hook);
    }

    /** Resolves once support has been probed and listeners are attached. */
    async whenReady(): Promise<void> {
        if (this.ready) await this.ready;
    }

    /** Edges for one slot only - what most callers actually want. */
    edgesFor(slot: number): Observable<boolean> {
        return this.transmit$.pipe(
            filter(e => e.slot === slot),
            map(e => e.down),
        );
    }

    async setBinding(slot: number, token: string): Promise<void> {
        await this.requireHook().pttSetBinding(slot, token);
    }

    async arm(slot: number): Promise<void> {
        await this.requireHook().pttArm(slot);
    }

    async disarm(slot: number): Promise<void> {
        await this.requireHook().pttDisarm(slot);
    }

    async cancelCapture(): Promise<void> {
        await this.requireHook().pttCancelCapture();
    }

    async label(token: string): Promise<string> {
        return this.requireHook().pttLabel(token);
    }

    /** Display label for a stored binding: the native hook formats its own tokens, everything else is an accelerator. */
    async labelFor(token: string): Promise<string> {
        await this.whenReady();
        if (this.supportedSig()) {
            try {
                return await this.label(token);
            } catch {
                // Fall through: a formatted accelerator beats showing a raw token.
            }
        }
        return formatAccelerator(token);
    }

    /** Enter capture mode for a slot; resolves with the next bound input (or a cancelled result). */
    async beginCapture(slot: number): Promise<PttCaptureResult> {
        const result = firstValueFrom(this.capture$);
        await this.requireHook().pttBeginCapture(slot);
        return result;
    }

    private async init(hook: NativePttHook): Promise<void> {
        try {
            const ok = await hook.pttSupported();
            this.supportedSig.set(ok);
            if (!ok) return;
            await hook.onPttEdge(edge => this.transmit$.next(edge));
            await hook.onPttCapture(result => this.capture$.next(result));
        } catch (err) {
            console.error('[native-ptt] init failed', err);
        }
    }

    /** The hook, or a rejection naming what is missing. Every caller already guards on `supported()`, so this path should be unreachable. */
    private requireHook(): NativePttHook {
        if (!this.hook) throw new Error('native push-to-talk hook is not available on this host');
        return this.hook;
    }
}
