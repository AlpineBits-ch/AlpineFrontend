/**
 * The declared list of wiki keyboard shortcuts. This file only describes the bindings; each one is
 * implemented elsewhere (the article's keydown handler, TipTap's own keymaps, the wiki host
 * listener), so a row here is a claim that has to stay true.
 */

import {WIKI_EDITOR_KEYBINDS, WikiEditorKeybindId} from '../../../../../models/keybind-action.model';

export type WikiShortcutGroup = 'navigation' | 'editing' | 'ai' | 'formatting';

export interface WikiShortcut {
    /** Key tokens, rendered as one chip each; `mod` becomes ⌘ on macOS and Ctrl elsewhere, the rest are printed as written. */
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

    // The formatting group is no longer listed here: every one of those keys is configurable now, so a hardcoded row would be a claim about a binding the user may have changed; see `wikiFormattingShortcuts`.
];

/** The translated name for each configurable editor action; reuses the keys the toolbar and slash menu already ship so the cheat sheet cannot drift out of agreement with them. */
const EDITOR_ACTION_LABELS: Record<WikiEditorKeybindId, string> = {
    'wiki-toggle-markdown': 'WIKI.SHORTCUTS.EDIT.TOGGLE_MARKDOWN',
    'wiki-bold': 'WIKI.FORMAT.BOLD',
    'wiki-italic': 'WIKI.FORMAT.ITALIC',
    'wiki-underline': 'WIKI.FORMAT.UNDERLINE',
    'wiki-strike': 'WIKI.FORMAT.STRIKETHROUGH',
    'wiki-inline-code': 'WIKI.FORMAT.INLINE_CODE',
    'wiki-heading-1': 'WIKI.BLOCK.HEADING_1',
    'wiki-heading-2': 'WIKI.BLOCK.HEADING_2',
    'wiki-heading-3': 'WIKI.BLOCK.HEADING_3',
    'wiki-bullet-list': 'WIKI.BLOCK.BULLET_LIST',
    'wiki-numbered-list': 'WIKI.BLOCK.NUMBERED_LIST',
    'wiki-task-list': 'WIKI.BLOCK.TASK_LIST',
    'wiki-quote': 'WIKI.BLOCK.QUOTE',
    'wiki-code-block': 'WIKI.BLOCK.CODE_BLOCK',
    'wiki-divider': 'WIKI.BLOCK.DIVIDER',
    'wiki-link': 'WIKI.FORMAT.LINK',
};

/** The formatting rows, read from whatever the actions are actually bound to right now: built rather than declared, since these are the user's to change. */
export function wikiFormattingShortcuts(
    binding: (id: WikiEditorKeybindId) => string | null,
): WikiShortcut[] {
    return WIKI_EDITOR_KEYBINDS.flatMap(action => {
        const id = action.id as WikiEditorKeybindId;
        const token = binding(id);
        if (!token) return [];
        return [{
            keys: acceleratorChips(token),
            labelKey: EDITOR_ACTION_LABELS[id],
            group: 'formatting' as const,
            editingOnly: id !== 'wiki-toggle-markdown',
        }];
    });
}

/** "Control+Shift+KeyB" as the chips the overlay renders: `['mod', 'Shift', 'B']`. The `Key`/`Digit` prefixes of a `KeyboardEvent.code` are dropped since they're how the binding is stored, not how it's read. */
export function acceleratorChips(token: string): string[] {
    return token.split('+').map(part => {
        if (part === 'Control' || part === 'Super') return 'mod';
        if (part === 'Alt' || part === 'Shift') return part;
        if (part.startsWith('Key')) return part.slice(3);
        if (part.startsWith('Digit') || part.startsWith('Numpad')) return part.replace(/^\D+/, '');
        return part;
    });
}

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
