import {CategoryDto, ChannelDto, ChannelPermission, ChannelType} from '../../../../dtos/response/guild.dto';

export type PermissionScopeKind = 'channel' | 'category';

/** What a set of overwrites hangs off, and everything the editor needs to know about it. */
export interface PermissionScope {
    kind: PermissionScopeKind;
    id: string;
    /** Null for a category: household permissions resolve per channel, so a category offers none. */
    channelType: ChannelType | null;
    overrides: ChannelPermission[];
}

export function channelScope(channel: ChannelDto): PermissionScope {
    return {kind: 'channel', id: channel.id, channelType: channel.type, overrides: channel.permissions};
}

export function categoryScope(category: CategoryDto): PermissionScope {
    return {kind: 'category', id: category.id, channelType: null, overrides: category.permissions};
}
