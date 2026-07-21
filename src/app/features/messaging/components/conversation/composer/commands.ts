export type CommandScope = 'global' | 'inline';

export interface CommandResult {
    /** Text to insert into the editor (inline) or send as a message (global). */
    text?: string;
    /** Side-effect action. Known local actions are handled by the composer;
     *  unknown ones are emitted to the parent via `commandAction` output. */
    action?: { name: string; payload?: unknown };
}

export interface CommandDef {
    name: string;
    description: string;
    /** `inline` -works anywhere mid-message, replaces the trigger text in-place.
     *  `global` -only available at the start of the editor; operates on the whole message. */
    scope: CommandScope;
    params: { label: string; required: boolean }[];
    execute: (params: string) => CommandResult;
}

export const COMMANDS: CommandDef[] = [
    {
        name: 'shrug',
        description: 'Insert ¯\\_(ツ)_/¯ at cursor',
        scope: 'inline',
        params: [],
        execute: () => ({text: '¯\\_(ツ)_/¯'}),
    },
    {
        name: 'gif',
        description: 'Search for a GIF',
        scope: 'global',
        params: [{label: 'search', required: true}],
        execute: (query) => ({action: {name: 'open-gif-picker-with-search', payload: {query: query.trim()}}}),
    },
];
