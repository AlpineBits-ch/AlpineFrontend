/**
 * The one notation this app stores key bindings in, and how it maps onto a DOM `KeyboardEvent`.
 *
 * <p>A stored token looks like `Control+Shift+KeyV`: zero or more modifier names, then a
 * `KeyboardEvent.code` for the main key, joined by `+`. That is what `KeybindsService`'s
 * `acceleratorFromEvent` writes, what `@tauri-apps/plugin-global-shortcut` registers, and what the
 * Windows hook's `parse_token` reads (`src-tauri/src/ptt_hook.rs:956`). A bare modifier - just
 * `Ctrl` - is also a valid token, because the native hook can bind one.</p>
 *
 * <p><b>Pure, and shared by both hosts on purpose.</b> The desktop path needs
 * {@link formatAccelerator} for its non-native label fallback and the browser path needs the whole
 * file; two implementations of "what does this token mean" is exactly how a binding ends up
 * displayable but impossible to trigger. Nothing here touches a host API, so it also runs in a plain
 * spec.</p>
 */

/** Which physical modifier a bare-modifier token names. */
export type BareModifier = 'Control' | 'Alt' | 'Shift' | 'Meta';

/**
 * A token in the form a `keydown` can be compared against.
 *
 * <p>Either {@link code} (a main key, with the modifier flags it requires) or {@link modifier} (a
 * bare-modifier binding) is set - never both, never neither.</p>
 */
export interface ParsedAccelerator {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    /** `KeyboardEvent.code` the main key must equal, or null for a bare-modifier binding. */
    code: string | null;
    /** The modifier this token binds on its own, or null when it has a main key. */
    modifier: BareModifier | null;
}

/**
 * Modifier spellings accepted on input.
 *
 * <p>Wider than what this app writes: `plugin-global-shortcut` accepts the Electron-style aliases and
 * a token could have been stored by an older build or hand-edited into `localStorage`. Accepting them
 * costs four lines; rejecting a token a user can see on the keybinds page does not.</p>
 */
const MODIFIERS: Readonly<Record<string, keyof Pick<ParsedAccelerator, 'ctrl' | 'alt' | 'shift' | 'meta'>>> = {
    Control: 'ctrl',
    Ctrl: 'ctrl',
    CommandOrControl: 'ctrl',
    CmdOrCtrl: 'ctrl',
    Alt: 'alt',
    Option: 'alt',
    Shift: 'shift',
    Super: 'meta',
    Meta: 'meta',
    Win: 'meta',
    Cmd: 'meta',
    Command: 'meta',
};

/** Main keys whose token already *is* the `KeyboardEvent.code`, beyond the regex families below. */
const LITERAL_CODES: readonly string[] = [
    'Backquote', 'Space', 'Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert',
    'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote',
    'Comma', 'Period', 'Slash', 'CapsLock', 'IntlBackslash',
];

/** Spellings of a main key that are not a `code` but map onto exactly one. */
const CODE_ALIASES: Readonly<Record<string, string>> = {
    Esc: 'Escape',
    Return: 'Enter',
    Spacebar: 'Space',
    Grave: 'Backquote',
    '`': 'Backquote',
};

/** `Key`/`Digit`/`F`/`Numpad` families, checked before the literal list. */
function familyCode(part: string): string | null {
    if (/^Key[A-Z]$/.test(part)) return part;
    if (/^Digit[0-9]$/.test(part)) return part;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(part)) return part;
    if (/^Numpad[A-Za-z0-9]+$/.test(part)) return part;
    // Tauri's "Key" notation as opposed to its "Code" notation: a bare letter or digit.
    if (/^[A-Z]$/.test(part)) return `Key${part}`;
    if (/^[0-9]$/.test(part)) return `Digit${part}`;
    return null;
}

function mainCode(part: string): string | null {
    return familyCode(part)
        ?? CODE_ALIASES[part]
        ?? (LITERAL_CODES.includes(part) ? part : null);
}

/**
 * The token as something a `keydown` can be matched against, or **null when this host cannot
 * represent it**.
 *
 * <p>Null is the honest answer for the native hook's own vocabulary - `MouseX1`, `MouseX2`,
 * `MouseMid` and raw `VK123` virtual-key tokens have no `KeyboardEvent` at all. A caller must surface
 * that rather than register a listener that can never fire; see the web adapter's `bind`, which
 * returns false and names the token.</p>
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
    const parsed: ParsedAccelerator = {
        ctrl: false, alt: false, shift: false, meta: false, code: null, modifier: null,
    };

    const parts = accelerator.split('+').map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length === 0) return null;

    for (const part of parts) {
        const flag = MODIFIERS[part];
        if (flag) {
            parsed[flag] = true;
            continue;
        }
        const code = mainCode(part);
        if (!code) return null;
        // Last main key wins, matching `parse_token`'s loop, so a token that arms on the native hook
        // is understood the same way here.
        parsed.code = code;
    }

    if (parsed.code) return parsed;

    // No main key: a *single* bare modifier is a binding in its own right and anything else is not.
    // Mirrors `parse_token` exactly, including that the modifier flags are cleared once it becomes
    // the main key - `Ctrl` means "the Ctrl key went down", not "Ctrl is held".
    const held: BareModifier[] = [];
    if (parsed.ctrl) held.push('Control');
    if (parsed.alt) held.push('Alt');
    if (parsed.shift) held.push('Shift');
    if (parsed.meta) held.push('Meta');
    if (held.length !== 1) return null;

    return {ctrl: false, alt: false, shift: false, meta: false, code: null, modifier: held[0]!};
}

/** The `KeyboardEvent.code` values that are the given modifier key. */
function modifierCodes(modifier: BareModifier): readonly string[] {
    switch (modifier) {
        case 'Control':
            return ['ControlLeft', 'ControlRight'];
        case 'Alt':
            return ['AltLeft', 'AltRight'];
        case 'Shift':
            return ['ShiftLeft', 'ShiftRight'];
        case 'Meta':
            return ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'];
    }
}

/**
 * Whether this `keydown` is the accelerator being pressed.
 *
 * <p><b>Modifier state is compared exactly</b>, not as a subset: a binding on `KeyV` does not fire on
 * Ctrl+V. That is what an OS-registered accelerator does, and the difference is not academic - the
 * usual push-to-talk key is a bare letter, and a subset match would key the microphone every time the
 * user pasted.</p>
 */
export function matchesKeyDown(parsed: ParsedAccelerator, event: KeyboardEvent): boolean {
    if (parsed.modifier) return modifierCodes(parsed.modifier).includes(event.code);

    return event.code === parsed.code
        && event.ctrlKey === parsed.ctrl
        && event.altKey === parsed.alt
        && event.shiftKey === parsed.shift
        && event.metaKey === parsed.meta;
}

/**
 * Whether this `keyup` ends a press that {@link matchesKeyDown} started.
 *
 * <p><b>Deliberately looser than the press, and this is a correctness requirement rather than a
 * convenience.</b> Releasing Ctrl before V on a `Control+KeyV` binding produces a `keyup` for `KeyV`
 * whose `ctrlKey` is already false; requiring the exact modifier state there would drop the release
 * and leave the microphone open. So a release is any of: the main key going up, or one of the
 * modifiers the binding needed going up - at which point the combination is no longer held either
 * way.</p>
 */
export function matchesKeyUp(parsed: ParsedAccelerator, event: KeyboardEvent): boolean {
    if (parsed.modifier) return modifierCodes(parsed.modifier).includes(event.code);
    if (event.code === parsed.code) return true;

    return (parsed.ctrl && modifierCodes('Control').includes(event.code))
        || (parsed.alt && modifierCodes('Alt').includes(event.code))
        || (parsed.shift && modifierCodes('Shift').includes(event.code))
        || (parsed.meta && modifierCodes('Meta').includes(event.code));
}

/**
 * The accelerator a `keydown` represents, in the notation bindings are stored in.
 *
 * <p><b>This must stay identical to `KeybindsService.acceleratorFromEvent`</b>, which is the same
 * function for the same reason and predates this file. It is duplicated rather than imported because
 * `platform/` is the bottom layer and may not depend on a service; the intended end state is that the
 * service re-exports this one. {@link parseAccelerator} of this output is what the web adapter matches
 * against, so the two agreeing is asserted rather than assumed - see `hotkeys.web.spec.ts`.</p>
 *
 * <p>`code` rather than `key`: the physical key, so a binding does not move when the layout changes and
 * so Shift combinations stay legible (`Shift+Digit8`, not `*`).</p>
 */
export function acceleratorFromEvent(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');
    parts.push(event.code);
    return parts.join('+');
}

/**
 * Human-readable form of an accelerator (e.g. `Control+Shift+KeyV` → `Ctrl + Shift + V`).
 *
 * <p>Moved here verbatim from `native-ptt.service.ts`, which still re-exports it under its old name:
 * this is the label for every binding the Windows hook is not formatting in Rust, which on web is all
 * of them.</p>
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
