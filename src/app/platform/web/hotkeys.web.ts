import {
    acceleratorFromEvent,
    formatAccelerator,
    matchesKeyDown,
    matchesKeyUp,
    ParsedAccelerator,
    parseAccelerator,
} from '../accelerator';
import {HotkeyHandlers, Hotkeys} from '../ports/hotkeys.port';

/** One live registration. */
interface Binding {
    accelerator: string;
    parsed: ParsedAccelerator;
    handlers: HotkeyHandlers;
    /** Debounces key-repeat so onDown/onUp fire only on real transitions. */
    isDown: boolean;
}

/** An in-flight rebinding capture. */
interface Capture {
    id: string;
    resolve: () => void;
    /** A modifier held with nothing else yet - becomes a bare-modifier token if released alone. */
    modifierCandidate: string | null;
}

/**
 * Hotkeys in a browser tab: real, and **focused-only**.
 *
 * <p>`global` is false and that is not a limitation to be worked around - no web API delivers a
 * `keydown` while the tab is unfocused, so the one case push-to-talk exists for (the *game* has focus)
 * cannot be served here at all. Voice activity detection is the substitute, wired by the voice track;
 * this adapter's job is to be honest about the difference so nothing offers a keybind that appears to
 * register and never fires.</p>
 *
 * <p>What it does do correctly, in the order the failures matter:</p>
 *
 * <ol>
 *   <li><b>Release on blur.</b> If the tab loses focus while the key is held, <i>no keyup ever
 *       arrives</i> - the release goes to whatever took focus. Without this the microphone stays open
 *       for as long as the user is away, which is the worst bug this file could have, so `blur` and
 *       `visibilitychange` both release every held binding.</li>
 *   <li><b>No firing while typing.</b> A `keydown` whose target is an input, a textarea or anything
 *       contenteditable is ignored, because this app has a rich text editor and a push-to-talk on `V`
 *       that keyed the microphone mid-sentence would be indistinguishable from a broken client.
 *       <b>`keyup` is never filtered</b> - a release is always safe to deliver, and dropping one
 *       because focus moved into a text box is another way to leave the microphone open.</li>
 *   <li><b>Key-repeat debounce.</b> `event.repeat` plus the same `isDown` transition guard the desktop
 *       adapter uses, because a held key repeats and each repeat is another `keydown`.</li>
 * </ol>
 *
 * <p>Listeners are attached in the <b>capture phase and never call `preventDefault`</b> for a bound
 * key: capture phase so a component that stops propagation cannot silently break a binding, and no
 * `preventDefault` because a hotkey here observes the key rather than consuming it - the same property
 * that made the native Windows hook preferable to `RegisterHotKey` on desktop
 * (`call-hotkey.service.ts` documents why). Capture mode is the exception; while rebinding, the key
 * must not also do its normal job.</p>
 */
export class WebHotkeys extends Hotkeys {
    readonly global = false;
    readonly focused = true;

    private readonly bindings = new Map<string, Binding>();
    private capture: Capture | null = null;
    private listening = false;
    /**
     * Whether the document is focused, as far as we last heard.
     *
     * <p>Starts true and is driven by events only. Not seeded from `document.hasFocus()`: a keydown
     * cannot reach an unfocused document anyway, so this flag is a guard against a stale event
     * arriving after a blur, and seeding it from a call that answers false in a headless context would
     * disable every binding instead.</p>
     */
    private documentFocused = true;

    private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event);
    private readonly onKeyUp = (event: KeyboardEvent): void => this.handleKeyUp(event);
    private readonly onBlur = (): void => {
        this.documentFocused = false;
        this.releaseAll();
    };
    private readonly onFocus = (): void => {
        this.documentFocused = true;
    };
    private readonly onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') this.onBlur();
        else this.documentFocused = true;
    };

    /**
     * Returns **false for a token this host cannot represent** rather than registering a listener that
     * can never match: the native hook's mouse buttons (`MouseX1`, `MouseX2`, `MouseMid`) and raw
     * `VK123` virtual keys have no `KeyboardEvent`, and a binding that silently never fires is the
     * exact failure the port's two booleans exist to prevent.
     */
    async bind(id: string, accelerator: string, handlers: HotkeyHandlers): Promise<boolean> {
        await this.unbind(id);

        const parsed = parseAccelerator(accelerator);
        if (!parsed) {
            console.warn(
                `[hotkey] '${accelerator}' has no keyboard equivalent in a browser, so '${id}' is not ` +
                    'bound. Mouse buttons and raw virtual-key tokens only exist on the native hook.',
            );
            return false;
        }

        this.bindings.set(id, {accelerator, parsed, handlers, isDown: false});
        this.startListening();
        return true;
    }

    async unbind(id: string): Promise<void> {
        const binding = this.bindings.get(id);
        if (!binding) return;
        this.bindings.delete(id);

        // A binding dropped while held still owes its release: the caller's gate is a boolean it set on
        // `onDown` and nothing else will ever clear it.
        if (binding.isDown) {
            binding.isDown = false;
            binding.handlers.onUp?.();
        }

        this.stopListeningIfIdle();
    }

    /** No `ptt_label` here, and none needed: the notation is the app's own. */
    async label(accelerator: string): Promise<string> {
        return formatAccelerator(accelerator);
    }

    /**
     * Read the next key the user presses and give it to the binding `id` already holds.
     *
     * <p>The port names no channel for the captured accelerator - see its doc comment - so what this
     * adapter can honestly do with the value is apply it: the binding registered under `id` keeps its
     * handlers and starts answering to the new key, and the promise resolves once the capture ends
     * (whether it took a key, was cancelled, or the user pressed Escape). `KeybindsService` does not
     * reach this path today; it runs its own DOM capture and only calls the port through
     * `NativePttService`, whose `supported()` is false on web.</p>
     */
    async beginCapture(id: string): Promise<void> {
        this.finishCapture();
        // Anything held when rebinding starts is released first - the new key will produce its own
        // press, and the old one's keyup may go somewhere else entirely.
        this.releaseAll();

        this.startListening();
        return new Promise<void>(resolve => {
            this.capture = {id, resolve, modifierCandidate: null};
        });
    }

    async cancelCapture(): Promise<void> {
        this.finishCapture();
        this.stopListeningIfIdle();
    }

    // ── DOM plumbing ─────────────────────────────────────────────────────────

    private handleKeyDown(event: KeyboardEvent): void {
        if (this.capture) {
            this.captureKeyDown(event);
            return;
        }
        if (!this.documentFocused) return;
        // Auto-repeat: the OS is repeating a key that is already down. The `isDown` guard below catches
        // this too; both are kept because a synthetic event may carry no `repeat` flag.
        if (event.repeat) return;
        if (isTypingTarget(event.target)) return;

        for (const binding of this.bindings.values()) {
            if (binding.isDown) continue;
            if (!matchesKeyDown(binding.parsed, event)) continue;
            binding.isDown = true;
            binding.handlers.onDown?.();
        }
    }

    private handleKeyUp(event: KeyboardEvent): void {
        if (this.capture) {
            this.captureKeyUp(event);
            return;
        }

        // Never gated on focus or on the event target: a release is always safe to deliver, and the
        // press it ends may well have happened before focus moved.
        for (const binding of this.bindings.values()) {
            if (!binding.isDown) continue;
            if (!matchesKeyUp(binding.parsed, event)) continue;
            binding.isDown = false;
            binding.handlers.onUp?.();
        }
    }

    /** Every held binding, released. The blur handler and the stuck-microphone case both land here. */
    private releaseAll(): void {
        for (const binding of this.bindings.values()) {
            if (!binding.isDown) continue;
            binding.isDown = false;
            binding.handlers.onUp?.();
        }
    }

    private captureKeyDown(event: KeyboardEvent): void {
        const capture = this.capture;
        if (!capture) return;
        event.preventDefault();
        event.stopPropagation();

        if (event.code === 'Escape') {
            this.finishCapture();
            this.stopListeningIfIdle();
            return;
        }
        if (isModifierCode(event.code)) {
            // Wait for a main key so "Ctrl+…" combinations can be built; a modifier released on its own
            // becomes a bare-modifier token in `captureKeyUp`, matching the native capture UX.
            capture.modifierCandidate = event.code;
            return;
        }

        const accelerator = acceleratorFromEvent(event);
        this.finishCapture(capture.id, accelerator);
        this.stopListeningIfIdle();
    }

    private captureKeyUp(event: KeyboardEvent): void {
        const capture = this.capture;
        if (!capture) return;
        if (!isModifierCode(event.code) || event.code !== capture.modifierCandidate) return;
        event.preventDefault();
        event.stopPropagation();
        this.finishCapture(capture.id, bareModifierToken(event.code));
        this.stopListeningIfIdle();
    }

    /**
     * End the pending capture, optionally re-pointing a binding at `accelerator`.
     *
     * <p>The rebind reuses {@link bind}, so an accelerator this host cannot represent is rejected the
     * same way there as anywhere else, and the promise still resolves - a capture that hung would
     * freeze the keybinds page. <b>It resolves after the rebind has landed</b>, not alongside it: a
     * caller that awaits the capture and then expects the new key to work would otherwise be racing a
     * microtask.</p>
     */
    private finishCapture(id?: string, accelerator?: string): void {
        const capture = this.capture;
        if (!capture) return;
        this.capture = null;

        const rebound =
            id !== undefined && accelerator !== undefined ? this.rebind(id, accelerator) : Promise.resolve();
        void rebound.then(() => capture.resolve());
    }

    /** Point an existing binding at a new accelerator, keeping its handlers. */
    private async rebind(id: string, accelerator: string): Promise<void> {
        const existing = this.bindings.get(id);
        if (!existing) return;
        await this.bind(id, accelerator, existing.handlers);
    }

    private startListening(): void {
        if (this.listening) return;
        this.listening = true;
        window.addEventListener('keydown', this.onKeyDown, true);
        window.addEventListener('keyup', this.onKeyUp, true);
        window.addEventListener('blur', this.onBlur);
        window.addEventListener('focus', this.onFocus);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    private stopListeningIfIdle(): void {
        if (!this.listening) return;
        if (this.bindings.size > 0 || this.capture) return;
        this.listening = false;
        window.removeEventListener('keydown', this.onKeyDown, true);
        window.removeEventListener('keyup', this.onKeyUp, true);
        window.removeEventListener('blur', this.onBlur);
        window.removeEventListener('focus', this.onFocus);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
}

/**
 * Whether this event is the user typing rather than the user reaching for a shortcut.
 *
 * <p>`closest` as well as `isContentEditable` because a TipTap selection can sit on a node inside the
 * editable root, and because `isContentEditable` is not implemented everywhere the specs run.</p>
 */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).closest !== 'function') return false;
    const element = target as HTMLElement;

    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (element.isContentEditable) return true;
    return element.closest('[contenteditable="true"], [contenteditable=""]') !== null;
}

function isModifierCode(code: string): boolean {
    return (
        code === 'ControlLeft' ||
        code === 'ControlRight' ||
        code === 'AltLeft' ||
        code === 'AltRight' ||
        code === 'ShiftLeft' ||
        code === 'ShiftRight' ||
        code === 'MetaLeft' ||
        code === 'MetaRight'
    );
}

/** The token a bare modifier is stored as, matching the native hook's `parse_token`. */
function bareModifierToken(code: string): string {
    if (code.startsWith('Control')) return 'Ctrl';
    if (code.startsWith('Alt')) return 'Alt';
    if (code.startsWith('Shift')) return 'Shift';
    return 'Win';
}
