import {afterEach, describe, expect, it} from 'vitest';
import {acceleratorFromEvent as platformAccelerator} from '../accelerator';
import {acceleratorFromEvent as serviceAccelerator} from '../../services/keybinds.service';
import {HotkeyHandlers} from '../ports/hotkeys.port';
import {WebHotkeys} from './hotkeys.web';

/**
 * The browser hotkey adapter, driven by synthetic `KeyboardEvent`s.
 *
 * <p>Every test here dispatches real events and asserts the <b>transitions</b> that reach the handlers,
 * because the thing worth testing is not that `bind` resolves - it is which edges arrive and when. The
 * four cases that decide whether this adapter is usable:</p>
 *
 * <ul>
 *   <li><b>Key held, then the tab loses focus.</b> No `keyup` is ever delivered, so without an explicit
 *       release the microphone stays open for as long as the user is away. This is the one bug that
 *       would be worse than having no web hotkeys at all.</li>
 *   <li><b>Auto-repeat.</b> A held key repeats; each repeat is another `keydown`. `onDown` must fire
 *       once.</li>
 *   <li><b>Typing.</b> This app has a TipTap editor, and a push-to-talk on `V` that keyed the mic while
 *       the user typed would look like a broken client. Presses inside a text field are ignored -
 *       releases are not.</li>
 *   <li><b>Modifier combinations.</b> Exact modifier state on the press, loose on the release, because
 *       releasing Ctrl before V is normal and must not strand the press.</li>
 * </ul>
 *
 * <p>Runs against jsdom, which delivers real DOM event propagation - capture phase, `bubbles`, targets -
 * so the listener wiring is genuinely exercised. What jsdom cannot provide is real focus: `blur`,
 * `focus` and `visibilitychange` are dispatched by hand, which tests this adapter's reaction to them
 * and not the browser's decision to send them.</p>
 */

interface Recorded {
    edges: string[];
    handlers: HotkeyHandlers;
}

/** A handler pair that records the sequence of edges it was given. */
function recorder(): Recorded {
    const edges: string[] = [];
    return {edges, handlers: {onDown: () => edges.push('down'), onUp: () => edges.push('up')}};
}

interface KeyOptions {
    code: string;
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
    repeat?: boolean;
    /** Where the event originates. Defaults to `window`, as a press with no focused element does. */
    target?: EventTarget;
}

function dispatchKey(type: 'keydown' | 'keyup', options: KeyOptions): KeyboardEvent {
    const event = new KeyboardEvent(type, {
        code: options.code,
        ctrlKey: options.ctrl ?? false,
        altKey: options.alt ?? false,
        shiftKey: options.shift ?? false,
        metaKey: options.meta ?? false,
        repeat: options.repeat ?? false,
        bubbles: true,
        cancelable: true,
    });
    (options.target ?? window).dispatchEvent(event);
    return event;
}

const keyDown = (options: KeyOptions): KeyboardEvent => dispatchKey('keydown', options);
const keyUp = (options: KeyOptions): KeyboardEvent => dispatchKey('keyup', options);

/**
 * Adapters created by a test, so their window listeners can be torn down.
 *
 * <p>Isolation is per spec *file*, not per test, so an adapter left bound would keep listening and see
 * the next test's events.</p>
 */
const live: {adapter: WebHotkeys; ids: string[]}[] = [];

function newAdapter(): WebHotkeys {
    const adapter = new WebHotkeys();
    live.push({adapter, ids: []});
    return adapter;
}

async function bind(
    adapter: WebHotkeys, id: string, accelerator: string, handlers: HotkeyHandlers,
): Promise<boolean> {
    live.find(entry => entry.adapter === adapter)?.ids.push(id);
    return adapter.bind(id, accelerator, handlers);
}

afterEach(async () => {
    for (const entry of live) {
        await entry.adapter.cancelCapture();
        for (const id of entry.ids) await entry.adapter.unbind(id);
    }
    live.length = 0;
    document.body.innerHTML = '';
    // The adapter only learns about focus from events, so a test that blurred has to hand it back.
    window.dispatchEvent(new Event('focus'));
});

describe('WebHotkeys', () => {
    it('reports focused-only reach', () => {
        const adapter = newAdapter();
        expect(adapter.global).toBe(false);
        expect(adapter.focused).toBe(true);
    });

    // ── The stuck-microphone case ────────────────────────────────────────────

    it('releases a held key when the window loses focus', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        expect(ptt.edges).toEqual(['down']);

        window.dispatchEvent(new Event('blur'));

        // The keyup never arrives - it goes to whatever took focus - so this is the only release.
        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('releases a held key when the tab is hidden', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        document.dispatchEvent(new Event('visibilitychange'));

        // jsdom reports `visibilityState === 'visible'`, so this asserts the handler is wired and
        // reacts to the event; the hidden branch is asserted below by faking the state.
        expect(ptt.edges).toEqual(['down']);

        const own = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
        try {
            document.dispatchEvent(new Event('visibilitychange'));
        } finally {
            delete (document as unknown as Record<string, unknown>)['visibilityState'];
            if (own) Object.defineProperty(document, 'visibilityState', own);
        }

        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('does not fire a second release when the keyup arrives after a blur', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        window.dispatchEvent(new Event('blur'));
        keyUp({code: 'KeyV'});

        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('ignores a press that arrives while the document is blurred, and binds again after focus', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        window.dispatchEvent(new Event('blur'));
        keyDown({code: 'KeyV'});
        expect(ptt.edges).toEqual([]);

        window.dispatchEvent(new Event('focus'));
        keyDown({code: 'KeyV'});
        expect(ptt.edges).toEqual(['down']);
    });

    it('releases a held key when its binding is dropped mid-press', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        await adapter.unbind('call-ptt');

        // The caller's gate is a boolean it set on `onDown`; nothing else would ever clear it.
        expect(ptt.edges).toEqual(['down', 'up']);
    });

    // ── Auto-repeat ──────────────────────────────────────────────────────────

    it('fires onDown once while a key repeats', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        keyDown({code: 'KeyV', repeat: true});
        keyDown({code: 'KeyV', repeat: true});
        // A repeat that forgot to set the flag is still a repeat, and the transition guard catches it.
        keyDown({code: 'KeyV'});
        keyUp({code: 'KeyV'});

        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('fires again after a full press/release cycle', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        keyUp({code: 'KeyV'});
        keyDown({code: 'KeyV'});
        keyUp({code: 'KeyV'});

        expect(ptt.edges).toEqual(['down', 'up', 'down', 'up']);
    });

    it('ignores a keyup for a key that was never pressed', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyUp({code: 'KeyV'});

        expect(ptt.edges).toEqual([]);
    });

    // ── Typing ───────────────────────────────────────────────────────────────

    it('ignores a press inside a text input', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        const input = document.createElement('input');
        document.body.appendChild(input);
        keyDown({code: 'KeyV', target: input});

        expect(ptt.edges).toEqual([]);
    });

    it('ignores a press inside a textarea or a contenteditable editor', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        keyDown({code: 'KeyV', target: textarea});

        // Shaped like TipTap: the event target is a node *inside* the editable root, not the root.
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        const paragraph = document.createElement('p');
        editor.appendChild(paragraph);
        document.body.appendChild(editor);
        keyDown({code: 'KeyV', target: paragraph});

        expect(ptt.edges).toEqual([]);
    });

    it('still releases when focus moves into a text field mid-press', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        const input = document.createElement('input');
        document.body.appendChild(input);
        keyUp({code: 'KeyV', target: input});

        // Filtering releases by target is another way to leave the microphone open.
        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('does not consume the key it observes', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        const event = keyDown({code: 'KeyV'});

        expect(ptt.edges).toEqual(['down']);
        expect(event.defaultPrevented).toBe(false);
    });

    // ── Modifier combinations ────────────────────────────────────────────────

    it('binds and unbinds a modifier combination', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        expect(await bind(adapter, 'call-ptt', 'Control+Shift+KeyV', ptt.handlers)).toBe(true);

        keyDown({code: 'KeyV', ctrl: true, shift: true});
        keyUp({code: 'KeyV', ctrl: true, shift: true});
        expect(ptt.edges).toEqual(['down', 'up']);

        await adapter.unbind('call-ptt');
        keyDown({code: 'KeyV', ctrl: true, shift: true});
        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('requires the exact modifier state on the press', async () => {
        const adapter = newAdapter();
        const combo = recorder();
        const bare = recorder();
        await bind(adapter, 'combo', 'Control+Shift+KeyV', combo.handlers);
        await bind(adapter, 'bare', 'KeyB', bare.handlers);

        keyDown({code: 'KeyV', ctrl: true});          // missing Shift
        keyDown({code: 'KeyV', ctrl: true, shift: true, alt: true}); // one modifier too many
        expect(combo.edges).toEqual([]);

        // The important half: a bare-letter push-to-talk must not fire on Ctrl+B.
        keyDown({code: 'KeyB', ctrl: true});
        expect(bare.edges).toEqual([]);
        keyDown({code: 'KeyB'});
        expect(bare.edges).toEqual(['down']);
    });

    it('releases when a required modifier is let go before the main key', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'Control+KeyV', ptt.handlers);

        keyDown({code: 'KeyV', ctrl: true});
        // Ctrl first: the following KeyV keyup would report `ctrlKey: false`, so a release that
        // demanded the exact press state would never match and the press would be stranded.
        keyUp({code: 'ControlLeft'});

        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('binds a bare modifier the way the native hook stores it', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        expect(await bind(adapter, 'call-ptt', 'Ctrl', ptt.handlers)).toBe(true);

        keyDown({code: 'ControlRight', ctrl: true});
        keyUp({code: 'ControlRight'});

        expect(ptt.edges).toEqual(['down', 'up']);
    });

    it('drives several bindings independently', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        const mute = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);
        await bind(adapter, 'call-push-to-mute', 'KeyB', mute.handlers);

        keyDown({code: 'KeyV'});
        keyDown({code: 'KeyB'});
        window.dispatchEvent(new Event('blur'));

        expect(ptt.edges).toEqual(['down', 'up']);
        expect(mute.edges).toEqual(['down', 'up']);
    });

    // ── Accelerators this host cannot represent ──────────────────────────────

    it('refuses a token with no keyboard equivalent instead of binding silently', async () => {
        const adapter = newAdapter();
        const ptt = recorder();

        expect(await bind(adapter, 'mouse', 'MouseX2', ptt.handlers)).toBe(false);
        expect(await bind(adapter, 'vk', 'VK86', ptt.handlers)).toBe(false);
        expect(await bind(adapter, 'mods-only', 'Control+Shift', ptt.handlers)).toBe(false);
        expect(await bind(adapter, 'empty', '', ptt.handlers)).toBe(false);
    });

    // ── Labels ───────────────────────────────────────────────────────────────

    it('labels an accelerator without the native hook', async () => {
        const adapter = newAdapter();

        await expect(adapter.label('Control+Shift+KeyV')).resolves.toBe('Ctrl + Shift + V');
        await expect(adapter.label('Super+Digit4')).resolves.toBe('Win + 4');
        await expect(adapter.label('Backquote')).resolves.toBe('`');
        await expect(adapter.label('Ctrl')).resolves.toBe('Ctrl');
    });

    // ── Capture ──────────────────────────────────────────────────────────────

    it('captures a new accelerator and re-points the binding at it', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        const captured = adapter.beginCapture('call-ptt');
        keyDown({code: 'ControlLeft', ctrl: true});
        keyDown({code: 'KeyT', ctrl: true});
        await captured;

        keyDown({code: 'KeyV'});                 // the old key is gone
        keyDown({code: 'KeyT', ctrl: true});     // the captured one answers
        expect(ptt.edges).toEqual(['down']);
    });

    it('does not fire bindings while capturing', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        const captured = adapter.beginCapture('other');
        keyDown({code: 'KeyV'});
        await captured;

        expect(ptt.edges).toEqual([]);
    });

    it('resolves the capture on Escape and on cancelCapture, leaving the binding alone', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        const escaped = adapter.beginCapture('call-ptt');
        keyDown({code: 'Escape'});
        await escaped;

        const cancelled = adapter.beginCapture('call-ptt');
        await adapter.cancelCapture();
        await cancelled;

        keyDown({code: 'KeyV'});
        expect(ptt.edges).toEqual(['down']);
    });

    it('releases anything held when a capture starts', async () => {
        const adapter = newAdapter();
        const ptt = recorder();
        await bind(adapter, 'call-ptt', 'KeyV', ptt.handlers);

        keyDown({code: 'KeyV'});
        const captured = adapter.beginCapture('call-ptt');
        await adapter.cancelCapture();
        await captured;

        // The old key's keyup may never come while the rebind dialog has focus.
        expect(ptt.edges).toEqual(['down', 'up']);
    });
});

describe('accelerator notation', () => {
    /**
     * The duplication guard. `platform/accelerator.ts` and `KeybindsService` both build this string,
     * because `platform/` may not depend on a service; two implementations drifting is how a shortcut
     * ends up displayable but impossible to trigger, so the agreement is asserted rather than trusted.
     */
    it('agrees with KeybindsService about what a keydown is called', () => {
        const events: KeyboardEvent[] = [
            new KeyboardEvent('keydown', {code: 'KeyV'}),
            new KeyboardEvent('keydown', {code: 'KeyV', ctrlKey: true, shiftKey: true}),
            new KeyboardEvent('keydown', {code: 'Digit8', shiftKey: true}),
            new KeyboardEvent('keydown', {code: 'F13', altKey: true, metaKey: true}),
            new KeyboardEvent('keydown', {code: 'Backquote', ctrlKey: true, altKey: true}),
        ];

        for (const event of events) {
            expect(platformAccelerator(event)).toBe(serviceAccelerator(event));
        }
    });

    it('binds what capture produced, for every combination KeybindsService can store', async () => {
        const adapter = newAdapter();

        const events = [
            new KeyboardEvent('keydown', {code: 'KeyV'}),
            new KeyboardEvent('keydown', {code: 'KeyV', ctrlKey: true, shiftKey: true}),
            new KeyboardEvent('keydown', {code: 'Digit8', shiftKey: true}),
            new KeyboardEvent('keydown', {code: 'F13', altKey: true, metaKey: true}),
            new KeyboardEvent('keydown', {code: 'Backquote', ctrlKey: true, altKey: true}),
            new KeyboardEvent('keydown', {code: 'Space'}),
            new KeyboardEvent('keydown', {code: 'Tab', ctrlKey: true}),
        ];

        for (const event of events) {
            const accelerator = serviceAccelerator(event);
            const recorded = recorder();
            expect(
                await bind(adapter, 'round-trip', accelerator, recorded.handlers),
                `${accelerator} came out of capture and must bind`,
            ).toBe(true);

            keyDown({
                code: event.code,
                ctrl: event.ctrlKey,
                alt: event.altKey,
                shift: event.shiftKey,
                meta: event.metaKey,
            });
            expect(recorded.edges, `${accelerator} must fire on the key it was captured from`)
                .toEqual(['down']);
            await adapter.unbind('round-trip');
        }
    });
});
