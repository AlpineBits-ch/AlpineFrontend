import {ForumConfig, ForumTag} from './forum.dto';

export interface WsGuildDeleted {
    guildId: string;
}

export interface WsGuildUpdated {
    guildId: string;
}

export interface WsForumTagEvent {
    guildId: string;
    channelId: string;
    tag: ForumTag;
}

export interface WsForumTagDeleted {
    guildId: string;
    channelId: string;
    tagId: string;
}

export interface WsForumTagsReordered {
    guildId: string;
    channelId: string;
    /** The full ordered list, not a delta. */
    tagIds: string[];
}

export interface WsForumConfigUpdated {
    guildId: string;
    channelId: string;
    config: ForumConfig;
}

export interface WsEmojiCreated {
    guildId: string;
    emojiId: string;
    name: string;
    animated: boolean;
}

export interface WsEmojiDeleted {
    guildId: string;
    emojiId: string;
}

export interface WsBotInstalled {
    guildId: string;
    /** The bot's user id. */
    userId: string;
}

export interface WsBotUninstalled {
    guildId: string;
    userId: string;
}

export interface WsEventCreated {
    guildId: string;
    eventId: string;
    title: string;
    startsAt: string;
}

export type WsEventUpdated = WsEventCreated;

export interface WsEventCancelled {
    guildId: string;
    eventId: string;
}
