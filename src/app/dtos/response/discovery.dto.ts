/**
 * Discovery: a browsable feed of public community listings, plus the per-guild listing a guild
 * manages to appear in it.
 *
 * {@link DiscoveryCardDto} is deliberately not {@link ListingDto}: the feed never carries drafts,
 * links or suspension reasons, and one type for both would invite a component to read a field that
 * is always undefined there.
 */

export type TopicKind = 'game' | 'tag';

export interface TopicDto {
    kind: TopicKind;
    id: string;
    name: string;
    steamAppId: string | null;
}

export type ListingState = 'Draft' | 'Published' | 'Suspended' | 'Unlisted';
export type JoinPolicy = 'Open' | 'Application';

export interface ListingDto {
    id: string;
    guildId: string;
    headline: string;
    pitch: string;
    topics: TopicDto[];
    language: string;
    joinPolicy: JoinPolicy;
    links: string[];
    state: ListingState;
    publishedAt: string | null;
    lastBumpedAt: string | null;
    /** When bumping stops answering `409`. Null once it is available. */
    bumpAvailableAt: string | null;
    /** Set only while {@link state} is `Suspended`. */
    suspendedReason: string | null;
}

export interface DiscoveryCardDto {
    listingId: string;
    guildId: string;
    guildName: string;
    guildIconUrl: string | null;
    guildBannerUrl: string | null;
    memberCount: number;
    headline: string;
    pitch: string;
    topics: TopicDto[];
    /** The subset of {@link topics} that matched the caller's search or interests. */
    matchedTopics: TopicDto[];
    language: string;
    joinPolicy: JoinPolicy;
    lastBumpedAt: string | null;
}

/** Cursor-paged, like the recipe list. `nextCursor: null` is the end and nothing else is. */
export interface DiscoveryFeedDto {
    cards: DiscoveryCardDto[];
    nextCursor: string | null;
}

export interface TopicSearchResultDto {
    topics: TopicDto[];
}

export interface InterestsDto {
    topics: TopicDto[];
    /** Whether other members can see this account follows these topics. */
    visible: boolean;
}

// ── Realtime (server -> client) ─────────────────────────────────────────────

/** Covers `ListingPublished`, `ListingUpdated` and `ListingUnlisted`. Partial: refetch, never patch. */
export interface WsListingChanged {
    listingId: string;
    guildId: string;
    state: ListingState;
}

export interface WsListingSuspended {
    listingId: string;
    guildId: string;
    reason: string;
}

export interface WsInterestsChanged {
    userId: string;
}
