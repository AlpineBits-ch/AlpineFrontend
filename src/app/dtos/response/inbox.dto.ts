import {MessageType} from '../../enums/message-type.enum';

/**
 * Where a piece of inbox activity happened, named end to end.
 *
 * <p>Everything here is an id plus the label the server already knows for it, so the inbox can
 * draw a row for a guild this client has not loaded. Ids are opaque: they sort by creation time
 * only if they were minted after the ULID change, so nothing in the inbox may compare two of
 * them to work out which is newer. `lastActivityAt` and `createdAt` are the ordering.</p>
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
    /**
     * Numeric on this endpoint, unlike {@link import('./guild.dto').ChannelType} which is a string
     * enum everywhere else in the app - and the spec never enumerates the values. Deliberately
     * unused: `InboxService` resolves the real channel out of `GuildService` by id instead, which
     * gives the authoritative type, and falls back to a plain `#` when it cannot.
     */
    channelType: number;
    /** Set for threads and forum posts, so a post can fall back to opening its parent. */
    parentChannelId: string | null;
    parentChannelName: string | null;
}

/**
 * A message body as the inbox serves it.
 *
 * <p>`content` is raw bytes, and ciphertext when {@link isEncrypted}. The server never decrypts,
 * so it cannot produce a text preview for an encrypted channel - that is this client's job, via
 * the same path channel history uses.</p>
 */
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
    /** Numeric, and *not* in the same order as {@link MessageType} - see {@link INBOX_MESSAGE_TYPES}. */
    type: number;
    /** 0-9, selecting the localized phrasing for a join/leave message. `content` is empty then. */
    systemMessageVariant: number | null;
    embedsJson: string | null;
}

/**
 * The inbox's numeric message types, transcribed from the spec.
 *
 * <p><b>Not an ordinal lookup.</b> The app's {@link MessageType} has `System` at index 1, which
 * the inbox's numbering does not - reading `Object.values(MessageType)[n]` would render an invite
 * as a system message and a join as an invite. Indexed by the wire value on purpose.</p>
 */
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
    /**
     * Best-effort. Derived from denormalized counters that drift under message loss, clamped at
     * zero, and for display only - unlike {@link mentionCount}, which is exact.
     */
    unreadCount: number;
    mentionCount: number;
    /** Oldest first, at most five. Empty when {@link InboxUnreadPage.previewsUnavailable}. */
    previews: InboxMessage[];
    previewsTruncated: boolean;
}

export interface InboxUnreadPage {
    groups: InboxUnreadGroup[];
    /** Opaque. Keyset, not offset - page until this is null, never on a count. */
    nextCursor: string | null;
    /**
     * The message service could not be reached. Groups, counts and breadcrumbs are still correct -
     * they come from elsewhere - so this is a `200` to render, not an error.
     */
    previewsUnavailable: boolean;
}

/** Which flavour of mention reached the user. The most specific one that applies. */
export type InboxMentionKind = 'Direct' | 'Here' | 'Everyone' | 'Role';

/**
 * `@everyone` and `@role` pings are not per-user rows, so there is nothing to delete for them -
 * the server accepts a dismissal and does nothing. Offering the control would be a lie.
 */
export function isDismissable(kind: InboxMentionKind): boolean {
    return kind === 'Direct' || kind === 'Here';
}

export interface InboxMention {
    messageId: string;
    /**
     * The index is keyed on this exact string. A dismissal must pass it back verbatim - a
     * re-serialized `Date` silently deletes nothing.
     */
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
    /** The real numbers are higher than reported; render as `99+`. */
    capped: boolean;
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
 * Sent to the acking user's *other* devices, so a second client's badge clears.
 *
 * <p>Read-all sends `{all: true}` with no channel id - that means "clear every badge", and a
 * handler that only looks for `channelId` silently ignores it.</p>
 */
export interface InboxReadStateChanged {
    channelId?: string;
    lastReadMessageId?: string;
    mentionCount?: number;
    all?: boolean;
}
