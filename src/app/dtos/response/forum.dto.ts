/**
 * Forum channels and their tags. A "post" is a Thread channel parented to a Forum
 * (or Media) channel - there is no separate post entity, which is why ForumPost
 * below is just ChannelDto with the forum-specific columns layered on.
 */

export interface ForumTag {
    id: string;
    /** The forum this tag belongs to. Tags never cross forums; an id is meaningless outside its own. */
    channelId: string;
    guildId: string;
    /** 1-20 chars, unique per forum, case-insensitive. */
    name: string;
    /** A guild emoji id. Mutually exclusive with emojiName. */
    emojiId?: string;
    /** A unicode emoji, e.g. "🐛". Mutually exclusive with emojiId. */
    emojiName?: string;
    /** "#RRGGBB". */
    color: string;
    position: number;
    /** Only moderators may apply or remove it. */
    moderated: boolean;
    /** Computed per request and excludes archived posts - never cache it as stable. */
    postCount: number;
}

export enum ForumSortOrder {
    LatestActivity = 'LatestActivity',
    CreationDate = 'CreationDate',
}

export enum ForumLayout {
    List = 'List',
    Gallery = 'Gallery',
}

/** Minutes, matching the four windows the backend accepts. */
export enum AutoArchiveDuration {
    OneHour = 60,
    OneDay = 1440,
    ThreeDays = 4320,
    OneWeek = 10080,
}

export interface ForumConfig {
    channelId: string;
    /** Posts must carry at least one tag. Enforced at write time only, never retroactively. */
    requireTag: boolean;
    defaultSortOrder: ForumSortOrder;
    /** Presentation hint - the backend stores and echoes it but never acts on it. */
    defaultLayout: ForumLayout;
    defaultReactionEmojiId?: string;
    defaultReactionEmojiName?: string;
    /** Copied onto each new post at creation; changing it doesn't touch existing posts. */
    defaultThreadSlowModeSeconds: number;
    defaultAutoArchiveMinutes: AutoArchiveDuration;
}

export interface ForumPost {
    id: string;
    guildId: string;
    /** The forum channel. */
    parentChannelId: string;
    type: string;
    /** The post title. */
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    createdByUserId: string;

    /** Applied tags, already ordered by each tag's own position - render in array order. */
    tagIds: string[];
    isPinned: boolean;
    /** No new messages, by moderator decision. Independent of isArchived. */
    isLocked: boolean;
    /** Off the default list, still readable, revived by posting. */
    isArchived: boolean;
    autoArchiveAt?: string;
    autoArchiveMinutes?: number;

    /** Last message timestamp; absent when the post has no messages. */
    lastActivityAt?: string;
    messageCount: number;

    isAgeRestricted: boolean;
    isPrivate: boolean;
    slowModeSeconds: number;
}

export interface ForumPostPage {
    posts: ForumPost[];
    /** Opaque - pass back verbatim, never parse or persist beyond the session. */
    nextCursor: string | null;
}

export type ForumTagMatch = 'any' | 'all';
export type ForumPostSort = 'activity' | 'created';
export type ForumArchivedFilter = 'false' | 'true' | 'all';

export interface ForumPostQuery {
    tagIds?: string[];
    match?: ForumTagMatch;
    sort?: ForumPostSort;
    archived?: ForumArchivedFilter;
    limit?: number;
    cursor?: string;
}

/** Hard caps the server enforces - mirrored client-side so the UI can prevent the 400. */
export const FORUM_LIMITS = {
    tagsPerForum: 20,
    tagsPerPost: 5,
    tagNameLength: 20,
} as const;
