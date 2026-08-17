/**
 * The one notation this app stores key bindings in, and how it maps onto a DOM `KeyboardEvent`.
 *
 * A stored token looks like `Control+Shift+KeyV`: zero or more modifier names, then a
 * `KeyboardEvent.code` for the main key, joined by `+`. A bare modifier is also a valid token.
 * Pure, shared by both hosts, and touches no host API.
 */

/** Which physical modifier a bare-modifier token names. */
export type BareModifier = 'Control' | 'Alt' | 'Shift' | 'Meta';

/**
 * A token in the form a `keydown` can be compared against.
 *
 * Exactly one of {@link code} and {@link modifier} is set: never both, never neither.
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

/** Modifier spellings accepted on input. Wider than what this app writes, to cover older tokens. */
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

/** Main keys whose token already is the `KeyboardEvent.code`, beyond the regex families below. */
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
 * The token as something a `keydown` can be matched against, or null when this host cannot
 * represent it (`MouseX1`, `VK123` and the rest of the native hook's own vocabulary).
 *
 * A caller must surface a null rather than register a listener that can never fire.
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
        // Last main key wins, matching `parse_token`'s loop.
        parsed.code = code;
    }

    if (parsed.code) return parsed;

    // No main key: exactly one bare modifier is a binding, anything else is not. Its flags are
    // cleared once it becomes the main key, so `Ctrl` means "Ctrl went down", not "Ctrl is held".
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
 * Modifier state is compared exactly, not as a subset: a binding on `KeyV` must not fire on Ctrl+V.
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
 * Must stay looser than the press: requiring exact modifier state here drops releases and leaves
 * the microphone open. A release is the main key going up, or any modifier the binding needed.
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
 * Must stay identical to `KeybindsService.acceleratorFromEvent`. Uses `code`, not `key`, so a
 * binding does not move when the layout changes.
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

/** Human-readable form of an accelerator (e.g. `Control+Shift+KeyV` → `Ctrl + Shift + V`). */
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
