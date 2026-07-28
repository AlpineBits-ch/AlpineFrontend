/**
 * Registry of every action the user can bind a global key to, Discord-style.
 *
 * Adding a new bindable action anywhere in the app is a single new entry
 * here (plus whatever service actually reacts to it) - the Keybinds settings
 * page, storage and capture UI all drive off this list automatically.
 */

export type KeybindActionId =
    | 'isle-ptt'
    | 'isle-toggle-mute'
    | 'isle-push-to-mute'
    | 'call-ptt'
    | 'call-toggle-mute'
    | 'call-push-to-mute';

/**
 * How a binding is captured and armed:
 *  - 'native': the Windows low-level hook - supports mouse buttons and bare
 *    modifiers, and keeps working while a game (not Alpine) has focus. Falls
 *    back to keyboard-only accelerators where the hook isn't available.
 *  - 'accelerator': a plain OS-registered keyboard shortcut. Simpler, and
 *    enough for actions that only ever fire while Alpine itself is in use.
 */
export type KeybindMechanism = 'native' | 'accelerator';

export interface KeybindActionDef {
    id: KeybindActionId;
    category: string;
    label: string;
    description: string;
    mechanism: KeybindMechanism;
    /** Native hook slot this action owns. Only present when mechanism is 'native'. */
    nativeSlot?: number;
}

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
        description: 'Hold to mute your Isle proximity mic. Handy when you\'re talking on another '
            + 'voice app at the same time and don\'t want it to pick you up too.',
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
        description: 'Hold to mute your mic during a call or voice channel. Handy when you\'re talking '
            + 'on another voice app at the same time and don\'t want it to pick you up too.',
        mechanism: 'native',
        nativeSlot: 5,
    },
];

export function findKeybindAction(id: KeybindActionId): KeybindActionDef {
    const action = KEYBIND_ACTIONS.find(a => a.id === id);
    if (!action) throw new Error(`Unknown keybind action: ${id}`);
    return action;
}
