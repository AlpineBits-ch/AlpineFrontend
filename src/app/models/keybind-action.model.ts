/** Registry of every action the user can bind a global key to, Discord-style. */

export type KeybindActionId =
    | 'isle-ptt'
    | 'isle-toggle-mute'
    | 'isle-push-to-mute'
    | 'call-ptt'
    | 'call-toggle-mute'
    | 'call-push-to-mute'
    | WikiEditorKeybindId;

/** The ids the wiki editor asks for by name when it builds its keymap. */
export type WikiEditorKeybindId =
    | 'wiki-toggle-markdown'
    | 'wiki-bold'
    | 'wiki-italic'
    | 'wiki-underline'
    | 'wiki-strike'
    | 'wiki-inline-code'
    | 'wiki-heading-1'
    | 'wiki-heading-2'
    | 'wiki-heading-3'
    | 'wiki-bullet-list'
    | 'wiki-numbered-list'
    | 'wiki-task-list'
    | 'wiki-quote'
    | 'wiki-code-block'
    | 'wiki-divider'
    | 'wiki-link';

/**
 * How a binding is captured and armed: 'native' is the Windows low-level hook, 'accelerator' an
 * OS-registered keyboard shortcut, 'in-app' a component handler that registers nothing with the OS.
 */
export type KeybindMechanism = 'native' | 'accelerator' | 'in-app';

export interface KeybindActionDef {
    id: KeybindActionId;
    category: string;
    label: string;
    description: string;
    mechanism: KeybindMechanism;
    /** Native hook slot this action owns. Only present when mechanism is 'native'. */
    nativeSlot?: number;
    /** What this action is bound to until somebody says otherwise. Only in-app actions have one. */
    defaultToken?: string;
}

/** The category the wiki editor's actions are grouped under on the Keybinds page. */
export const WIKI_EDITOR_CATEGORY = 'Wiki Editor';

export const KEYBIND_ACTIONS: readonly KeybindActionDef[] = [
    {
        id: 'isle-ptt',
        category: 'Isle Proxchat',
        label: 'Push to Talk',
        description: 'Hold to transmit over Isle proximity voice.',
        mechanism: 'native',
        nativeSlot: 0,
    },
    {
        id: 'isle-toggle-mute',
        category: 'Isle Proxchat',
        label: 'Toggle Mute',
        description: 'Press to mute or unmute your Isle proximity mic.',
        mechanism: 'native',
        nativeSlot: 1,
    },
    {
        id: 'isle-push-to-mute',
        category: 'Isle Proxchat',
        label: 'Push to Mute',
        description:
            "Hold to mute your Isle proximity mic. Handy when you're talking on another " +
            "voice app at the same time and don't want it to pick you up too.",
        mechanism: 'native',
        nativeSlot: 2,
    },
    {
        id: 'call-ptt',
        category: 'Voice Calls',
        label: 'Push to Talk',
        description: 'Hold to transmit during a call or voice channel.',
        mechanism: 'native',
        nativeSlot: 3,
    },
    {
        id: 'call-toggle-mute',
        category: 'Voice Calls',
        label: 'Toggle Mute',
        description: 'Press to mute or unmute your mic during a call or voice channel.',
        mechanism: 'native',
        nativeSlot: 4,
    },
    {
        id: 'call-push-to-mute',
        category: 'Voice Calls',
        label: 'Push to Mute',
        description:
            "Hold to mute your mic during a call or voice channel. Handy when you're talking " +
            "on another voice app at the same time and don't want it to pick you up too.",
        mechanism: 'native',
        nativeSlot: 5,
    },
    ...wikiEditorActions(),
];

/** The wiki editor's shortcuts. */
function wikiEditorActions(): KeybindActionDef[] {
    const rows: [WikiEditorKeybindId, string, string, string][] = [
        [
            'wiki-toggle-markdown',
            'Toggle Markdown Source',
            'Switch between the rich text editor and raw markdown.',
            'Control+Shift+KeyM',
        ],
        ['wiki-bold', 'Bold', 'Wrap the selection in bold.', 'Control+KeyB'],
        ['wiki-italic', 'Italic', 'Wrap the selection in italics.', 'Control+KeyI'],
        ['wiki-underline', 'Underline', 'Underline the selection.', 'Control+KeyU'],
        ['wiki-strike', 'Strikethrough', 'Strike through the selection.', 'Control+Shift+KeyS'],
        ['wiki-inline-code', 'Inline Code', 'Format the selection as inline code.', 'Control+KeyE'],
        [
            'wiki-heading-1',
            'Heading 1',
            'Turn the current block into a level 1 heading.',
            'Control+Alt+Digit1',
        ],
        [
            'wiki-heading-2',
            'Heading 2',
            'Turn the current block into a level 2 heading.',
            'Control+Alt+Digit2',
        ],
        [
            'wiki-heading-3',
            'Heading 3',
            'Turn the current block into a level 3 heading.',
            'Control+Alt+Digit3',
        ],
        ['wiki-bullet-list', 'Bullet List', 'Turn the selection into a bullet list.', 'Control+Shift+Digit8'],
        [
            'wiki-numbered-list',
            'Numbered List',
            'Turn the selection into a numbered list.',
            'Control+Shift+Digit7',
        ],
        ['wiki-task-list', 'Checklist', 'Turn the selection into a checklist.', 'Control+Shift+Digit9'],
        ['wiki-quote', 'Quote', 'Wrap the selection in a block quote.', 'Control+Shift+KeyB'],
        ['wiki-code-block', 'Code Block', 'Turn the selection into a code block.', 'Control+Alt+KeyC'],
        ['wiki-divider', 'Divider', 'Insert a horizontal rule.', 'Control+Alt+KeyR'],
        // Not Ctrl+K, which the wiki already spends on the search palette.
        ['wiki-link', 'Link', 'Turn the selection into a link.', 'Control+Shift+KeyK'],
    ];
    return rows.map(([id, label, description, defaultToken]) => ({
        id,
        category: WIKI_EDITOR_CATEGORY,
        label,
        description,
        mechanism: 'in-app' as const,
        defaultToken,
    }));
}

/** Every action the wiki editor binds, in the order the shortcuts overlay lists them. */
export const WIKI_EDITOR_KEYBINDS: readonly KeybindActionDef[] = KEYBIND_ACTIONS.filter(
    action => action.category === WIKI_EDITOR_CATEGORY,
);

export function findKeybindAction(id: KeybindActionId): KeybindActionDef {
    const action = KEYBIND_ACTIONS.find(a => a.id === id);
    if (!action) throw new Error(`Unknown keybind action: ${id}`);
    return action;
}
