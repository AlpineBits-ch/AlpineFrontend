import {ChannelType} from '../../../../../../../dtos/response/guild.dto';
import {PermissionKey} from '../../../../../../../enums/permissions.enum';

const MESSAGE_COLUMNS: PermissionKey[] = [
    'ViewChannel',
    'SendMessages',
    'ReadMessageHistory',
    'CreateThreads',
    'ManageChannel',
];

const VOICE_COLUMNS: PermissionKey[] = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'ManageChannel'];

/** Household channels carry their permissions in the module mask, which this grid does not edit. */
const STRUCTURED_COLUMNS: PermissionKey[] = ['ViewChannel'];

export function columnsFor(type: ChannelType): PermissionKey[] {
    switch (type) {
        case ChannelType.Voice:
            return VOICE_COLUMNS;
        case ChannelType.Text:
        case ChannelType.Announcement:
        case ChannelType.Forum:
        case ChannelType.Media:
            return MESSAGE_COLUMNS;
        default:
            return STRUCTURED_COLUMNS;
    }
}

/** Union of every column any channel type can show, in a stable header order. */
export const ALL_CHANNEL_COLUMNS: PermissionKey[] = [
    'ViewChannel',
    'SendMessages',
    'ReadMessageHistory',
    'CreateThreads',
    'Connect',
    'Speak',
    'Stream',
    'ManageChannel',
];
