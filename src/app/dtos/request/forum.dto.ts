import {AutoArchiveDuration, ForumLayout, ForumSortOrder} from '../response/forum.dto';

export interface CreateForumTagDto {
    name: string;
    emojiId?: string;
    emojiName?: string;
    color?: string;
    moderated?: boolean;
}

/**
 * Only the fields sent are touched. To clear an emoji send an empty string -
 * null/undefined means "leave unchanged", the convention used across this API.
 */
export interface UpdateForumTagDto {
    name?: string;
    emojiId?: string;
    emojiName?: string;
    color?: string;
    moderated?: boolean;
}

/** The complete ordered list of the forum's tag ids - partial lists are rejected. */
export interface ReorderForumTagsDto {
    tagIds: string[];
}

export interface UpdateForumConfigDto {
    requireTag?: boolean;
    defaultSortOrder?: ForumSortOrder;
    defaultLayout?: ForumLayout;
    defaultReactionEmojiId?: string;
    defaultReactionEmojiName?: string;
    defaultThreadSlowModeSeconds?: number;
    defaultAutoArchiveMinutes?: AutoArchiveDuration;
}

/** Replace semantics - send the complete desired set, not a delta. */
export interface SetPostTagsDto {
    tagIds: string[];
}

export interface SetPostPinnedDto {
    pinned: boolean;
}

export interface SetPostLockedDto {
    locked: boolean;
}
