/**
 * The declared list of wiki keyboard shortcuts.
 *
 * A list, not markup: the wiki grew ⌘S, ⌘K, `/` and `[[` without ever telling anybody they
 * existed, and it is about to grow `:`, `@` and Tab. Adding a row here is the whole job of
 * documenting a new one - nothing in the overlay's layout has to be touched.
 *
 * This file only *describes* the bindings. Every one of them is implemented elsewhere (the
 * article's keydown handler, TipTap's own keymaps, the wiki host listener), so a row here is a
 * claim that has to stay true.
 */

export type WikiShortcutGroup = 'navigation' | 'editing' | 'ai' | 'formatting';

export interface WikiShortcut {
    /**
     * Key tokens, rendered as one chip each. `mod` becomes ⌘ on macOS and Ctrl elsewhere; the
     * rest are printed as written.
     */
    readonly keys: readonly string[];
    readonly labelKey: string;
    readonly group: WikiShortcutGroup;
    /** Marked in the overlay, because half of these do nothing on a page you are only reading. */
    readonly editingOnly?: boolean;
}

export const WIKI_SHORTCUT_GROUPS: readonly {id: WikiShortcutGroup; labelKey: string}[] = [
    {id: 'navigation', labelKey: 'WIKI.SHORTCUTS.GROUP.NAVIGATION'},
    {id: 'editing', labelKey: 'WIKI.SHORTCUTS.GROUP.EDITING'},
    {id: 'ai', labelKey: 'WIKI.SHORTCUTS.GROUP.AI'},
    {id: 'formatting', labelKey: 'WIKI.SHORTCUTS.GROUP.FORMATTING'},
];

export const WIKI_SHORTCUTS: readonly WikiShortcut[] = [
    // Navigation
    {keys: ['mod', 'K'], labelKey: 'WIKI.SHORTCUTS.NAV.SEARCH', group: 'navigation'},
    {keys: ['e'], labelKey: 'WIKI.SHORTCUTS.NAV.EDIT', group: 'navigation'},
    {keys: ['?'], labelKey: 'WIKI.SHORTCUTS.NAV.HELP', group: 'navigation'},
    {keys: ['Esc'], labelKey: 'WIKI.SHORTCUTS.NAV.CLOSE', group: 'navigation'},

    // Editing
    {keys: ['mod', 'S'], labelKey: 'WIKI.SHORTCUTS.EDIT.SAVE', group: 'editing', editingOnly: true},
    {keys: ['/'], labelKey: 'WIKI.SHORTCUTS.EDIT.BLOCKS', group: 'editing', editingOnly: true},
    {keys: ['[['], labelKey: 'WIKI.SHORTCUTS.EDIT.LINK_PAGE', group: 'editing', editingOnly: true},
    {keys: [':'], labelKey: 'WIKI.SHORTCUTS.EDIT.EMOJI', group: 'editing', editingOnly: true},
    {keys: ['@'], labelKey: 'WIKI.SHORTCUTS.EDIT.MENTION', group: 'editing', editingOnly: true},
    {keys: ['mod', 'Z'], labelKey: 'WIKI.SHORTCUTS.EDIT.UNDO', group: 'editing', editingOnly: true},
    {
        keys: ['mod', 'Shift', 'Z'],
        labelKey: 'WIKI.SHORTCUTS.EDIT.REDO',
        group: 'editing',
        editingOnly: true,
    },

    // AI
    {keys: ['Tab'], labelKey: 'WIKI.SHORTCUTS.AI.ACCEPT', group: 'ai', editingOnly: true},
    {keys: ['Esc'], labelKey: 'WIKI.SHORTCUTS.AI.DISMISS', group: 'ai', editingOnly: true},

    // Formatting. Labels reuse the keys the toolbar and the slash menu already ship, so the
    // cheat sheet cannot drift out of agreement with the buttons that do the same thing.
    {keys: ['mod', 'B'], labelKey: 'WIKI.FORMAT.BOLD', group: 'formatting', editingOnly: true},
    {keys: ['mod', 'I'], labelKey: 'WIKI.FORMAT.ITALIC', group: 'formatting', editingOnly: true},
    {keys: ['mod', 'U'], labelKey: 'WIKI.FORMAT.UNDERLINE', group: 'formatting', editingOnly: true},
    {
        keys: ['mod', 'Shift', 'S'],
        labelKey: 'WIKI.FORMAT.STRIKETHROUGH',
        group: 'formatting',
        editingOnly: true,
    },
    {keys: ['mod', 'E'], labelKey: 'WIKI.FORMAT.INLINE_CODE', group: 'formatting', editingOnly: true},
    {
        keys: ['mod', 'Alt', '1'],
        labelKey: 'WIKI.SHORTCUTS.FORMAT.HEADING',
        group: 'formatting',
        editingOnly: true,
    },
    {
        keys: ['mod', 'Shift', '8'],
        labelKey: 'WIKI.BLOCK.BULLET_LIST',
        group: 'formatting',
        editingOnly: true,
    },
    {
        keys: ['mod', 'Shift', '7'],
        labelKey: 'WIKI.BLOCK.NUMBERED_LIST',
        group: 'formatting',
        editingOnly: true,
    },
    {
        keys: ['mod', 'Shift', 'B'],
        labelKey: 'WIKI.BLOCK.QUOTE',
        group: 'formatting',
        editingOnly: true,
    },
    {
        keys: ['mod', 'Alt', 'C'],
        labelKey: 'WIKI.BLOCK.CODE_BLOCK',
        group: 'formatting',
        editingOnly: true,
    },
];

/** Same user-agent test the titlebar uses to decide which window controls to draw. */
export function isMacKeyboard(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('mac os') || ua.includes('macos');
}

/** `mod` is the only token that differs by platform; everything else prints as declared. */
export function shortcutKeyLabel(token: string, mac: boolean): string {
    if (token === 'mod') return mac ? '⌘' : 'Ctrl';
    if (token === 'Alt') return mac ? '⌥' : 'Alt';
    if (token === 'Shift') return mac ? '⇧' : 'Shift';
    return token;
}

export function shortcutsIn(group: WikiShortcutGroup): readonly WikiShortcut[] {
    return WIKI_SHORTCUTS.filter(s => s.group === group);
}
