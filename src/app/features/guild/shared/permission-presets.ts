import {ChannelType} from '../../../dtos/response/guild.dto';
import {PermissionKey, Permissions} from '../../../enums/permissions.enum';
import {
    EMPTY_OVERRIDE,
    PermOverride,
} from './permission-override-editor/permission-override-editor.component';

/** A named starting point. Writes the same masks the grid would, and stays editable after. */
export interface PermissionPreset {
    id: string;
    labelKey: string;
    /** Offered on voice channels instead of the message presets, not alongside them. */
    voice: boolean;
    allow: PermissionKey[];
    deny: PermissionKey[];
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
    {
        id: 'read-only',
        labelKey: 'PERM_PRESET.READ_ONLY',
        voice: false,
        allow: ['ViewChannel', 'ReadMessageHistory'],
        deny: ['SendMessages', 'CreateThreads', 'AddReactions'],
    },
    {
        id: 'hidden',
        labelKey: 'PERM_PRESET.HIDDEN',
        voice: false,
        allow: [],
        deny: ['ViewChannel'],
    },
    {
        id: 'talk-not-manage',
        labelKey: 'PERM_PRESET.TALK_NOT_MANAGE',
        voice: false,
        allow: ['ViewChannel', 'SendMessages', 'CreateThreads', 'ReadMessageHistory'],
        deny: ['PinMessages', 'ManageChannel'],
    },
    {
        id: 'listen-only',
        labelKey: 'PERM_PRESET.LISTEN_ONLY',
        voice: true,
        allow: ['ViewChannel', 'Connect'],
        deny: ['Speak', 'Stream'],
    },
];

export function presetOverride(preset: PermissionPreset): PermOverride {
    const allow = preset.allow.reduce((mask, key) => mask | Permissions[key], 0n);
    const deny = preset.deny.reduce((mask, key) => mask | Permissions[key], 0n);
    return {...EMPTY_OVERRIDE, allow, deny};
}

/** Hidden is offered everywhere; the rest split on whether the channel carries voice. */
export function presetsFor(channelType: ChannelType | null): readonly PermissionPreset[] {
    const isVoice = channelType === ChannelType.Voice;
    return PERMISSION_PRESETS.filter(preset => preset.id === 'hidden' || preset.voice === isVoice);
}
