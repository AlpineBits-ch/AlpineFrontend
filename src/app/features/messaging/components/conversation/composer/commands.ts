import {BotCommandDto} from '../../../../../dtos/response/bot-command.dto';

export type CommandScope = 'global' | 'inline';

export interface CommandResult {
    /** Text to insert into the editor (inline) or send as a message (global). */
    text?: string;
    /** Side-effect action. Known local actions are handled by the composer;
     *  unknown ones are emitted to the parent via `commandAction` output. */
    action?: {name: string; payload?: unknown};
}

export interface CommandDef {
    name: string;
    description: string;
    /** `inline` -works anywhere mid-message, replaces the trigger text in-place.
     *  `global`, only available at the start of the editor; operates on the whole message. */
    scope: CommandScope;
    params: {label: string; required: boolean}[];
    execute: (params: string) => CommandResult;
}

/** Unifies the local (client-only) `/` commands below with server-provided bot slash commands
 *  fetched per-guild, so the overlay's keyboard nav / selection can operate over one flat,
 *  indexable list regardless of where a candidate command came from. `kind` (not `scope`) is the
 *  discriminant deliberately: `CommandDef.scope` ('inline'/'global') and `BotCommandDto.scope`
 *  ('global'/'guild') share a field name but mean different things. */
export type ComposerCommandItem = {kind: 'local'; def: CommandDef} | {kind: 'bot'; def: BotCommandDto};

export const COMMANDS: CommandDef[] = [
    {
        name: 'shrug',
        description: 'Insert ¯\\_(ツ)_/¯ at cursor',
        scope: 'inline',
        params: [],
        execute: () => ({text: '¯\\_(ツ)_/¯'}),
    },
    {
        // The muscle memory every roleplayer arrives with. Everything after the notation is the
        // reason, so `/roll 1d20+7 Perception` reads the way people already write it.
        name: 'roll',
        description: 'Roll dice on the server',
        scope: 'global',
        params: [
            {label: 'notation', required: true},
            {label: 'reason', required: false},
        ],
        execute: input => {
            const trimmed = input.trim();
            const split = trimmed.indexOf(' ');
            const expression = split === -1 ? trimmed : trimmed.slice(0, split);
            const reason = split === -1 ? '' : trimmed.slice(split + 1).trim();
            return {action: {name: 'roll-dice', payload: {expression, reason}}};
        },
    },
    {
        name: 'gif',
        description: 'Search for a GIF',
        scope: 'global',
        params: [{label: 'search', required: true}],
        execute: query => ({action: {name: 'open-gif-picker-with-search', payload: {query: query.trim()}}}),
    },
];
