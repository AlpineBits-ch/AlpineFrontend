import {MessageType} from '../../enums/message-type.enum';

/**
 * Where a piece of inbox activity happened, named end to end. Ids are opaque and must never be
 * compared for recency; `lastActivityAt` and `createdAt` are the ordering.
 */
export interface InboxBreadcrumb {
    guildId: string;
    guildName: string;
    guildIconUrl: string;
    guildIconThumbnailUrl: string;
    /** Null when the channel sits outside any category. */
    categoryId: string | null;
    categoryName: string | null;
    channelId: string;
    channelName: string;
    /** Numeric on this endpoint, unlike the string {@link import('./guild.dto').ChannelType} used elsewhere. */
    channelType: number;
    /** Set for threads and forum posts, so a post can fall back to opening its parent. */
    parentChannelId: string | null;
    parentChannelName: string | null;
}

/** A message body as the inbox serves it. `content` is raw bytes, ciphertext when {@link isEncrypted}. */
export interface InboxMessage {
    id: string;
    createdAt: string;
    authorId: string;
    /** Set for webhook and bot authors, who have no profile to look up. */
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
    /** Base64 bytes. Ciphertext when {@link isEncrypted}. */
    content: string;
    isEncrypted: boolean;
    /** Which encryption era the ciphertext belongs to. Picks the MLS group to decrypt against. */
    mlsGeneration: number | null;
    /** Numeric, and not in the same order as {@link MessageType}. See {@link INBOX_MESSAGE_TYPES}. */
    type: number;
    /** 0-9, selecting the localized phrasing for a join/leave message. `content` is empty then. */
    systemMessageVariant: number | null;
    embedsJson: string | null;
}

/** The inbox's numeric message types, indexed by wire value. Not an ordinal lookup into {@link MessageType}. */
export const INBOX_MESSAGE_TYPES: readonly MessageType[] = [
    MessageType.Message,
    MessageType.Invite,
    MessageType.GuildMemberJoin,
    MessageType.GuildMemberLeave,
];

/** One channel with unread activity, plus the newest few messages in it. */
export interface InboxUnreadGroup {
    breadcrumb: InboxBreadcrumb;
    lastActivityAt: string;
    /** Best-effort and for display only, unlike {@link mentionCount}, which is exact. */
    unreadCount: number;
    mentionCount: number;
    /** Oldest first, at most five. Empty when {@link InboxUnreadPage.previewsUnavailable}. */
    previews: InboxMessage[];
    previewsTruncated: boolean;
}

export interface InboxUnreadPage {
    groups: InboxUnreadGroup[];
    /** Opaque. Keyset, not offset: page until this is null, never on a count. */
    nextCursor: string | null;
    /** The message service could not be reached. Groups and counts are still correct; render the `200`. */
    previewsUnavailable: boolean;
}

/** Which flavour of mention reached the user. The most specific one that applies. */
export type InboxMentionKind = 'Direct' | 'Here' | 'Everyone' | 'Role';

/** `@everyone` and `@role` pings are not per-user rows, so there is nothing to dismiss for them. */
export function isDismissable(kind: InboxMentionKind): boolean {
    return kind === 'Direct' || kind === 'Here';
}

export interface InboxMention {
    messageId: string;
    /** The index is keyed on this exact string. A dismissal must pass it back verbatim. */
    createdAt: string;
    kind: InboxMentionKind;
    roleId: string | null;
    roleName: string | null;
    authorId: string;
    /** Null for a DM mention, where {@link conversationId} is set instead. */
    breadcrumb: InboxBreadcrumb | null;
    conversationId: string | null;
    message: InboxMessage;
}

export interface InboxMentionsPage {
    mentions: InboxMention[];
    nextCursor: string | null;
}

/** How far back the Mentions tab looks. Capped at the 31-day retention window regardless. */
export type InboxMentionWindow = '24h' | '7d' | '30d';

export interface InboxSummary {
    unreadChannelCount: number;
    mentionCount: number;
    /** The Waiting-on-you tab, capped the same way. */
    taskCount: number;
    /** The real numbers are higher than reported; render as `99+`. */
    capped: boolean;
}

// ── Waiting on you ──────────────────────────────────────────────────────────

/** The kinds of task the server knows about today. Open: an unknown kind still renders. */
export type InboxTaskKind =
    | 'ChoreDue' | 'DecisionVote' | 'ListAssignment'
    /** A bill is coming due. `targetId` is the bill occurrence. */
    | 'BillDue'
    /** You are down to cook today. `targetId` is the meal plan entry. */
    | 'CookingToday'
    /** A service is overdue or a warranty is lapsing. `targetId` is the asset. */
    | 'MaintenanceDue'
    | (string & {});

/** One thing waiting on the caller, from any guild they are in. */
export interface InboxTask {
    kind: InboxTaskKind;
    /** An occurrence, decision, list item, bill, meal plan entry or asset, per {@link kind}. */
    targetId: string;
    breadcrumb: InboxBreadcrumb;
    /** Server-written, and rendered as given. See {@link InboxTaskKind}. */
    title: string;
    subtitle: string;
    /** Null for a list assignment, which is waiting on nobody's clock. */
    dueAt: string | null;
    /** Server-decided, and not `dueAt < now`. Never recompute it from `dueAt`. */
    isOverdue: boolean;
}

/** A page of tasks, with no cursor. {@link truncated} says more were waiting. */
export interface InboxTaskPage {
    tasks: InboxTask[];
    truncated: boolean;
}

// ── Realtime (server → client) ──────────────────────────────────────────────

/** Sent only to users the message actually mentioned, and only those who can see the channel. */
export interface InboxMentionAdded {
    messageId: string;
    channelId: string;
    guildId: string;
    conversationId: string | null;
    authorId: string;
    kind: InboxMentionKind;
    createdAt: string;
}

/**
 * Sent to the acking user's other devices, so a second client's badge clears. Read-all sends
 * `{all: true}` with no channel id, meaning clear every badge.
 */
export interface InboxReadStateChanged {
    channelId?: string;
    lastReadMessageId?: string;
    mentionCount?: number;
    all?: boolean;
}
