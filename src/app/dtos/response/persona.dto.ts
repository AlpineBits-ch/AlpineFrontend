/** A persona belongs either to one account, everywhere, or to one guild. */
export const PersonaScope = {
    User: 'User',
    Guild: 'Guild',
} as const;

export type PersonaScope = (typeof PersonaScope)[keyof typeof PersonaScope];

export const PersonaApprovalState = {
    Draft: 'Draft',
    Submitted: 'Submitted',
    Approved: 'Approved',
    ChangesRequested: 'ChangesRequested',
} as const;

export type PersonaApprovalState = (typeof PersonaApprovalState)[keyof typeof PersonaApprovalState];

/** How this guild's character page compares to the reference copy. Lowercase on the wire. */
export const PersonaUpstreamState = {
    Current: 'current',
    Behind: 'behind',
    Diverged: 'diverged',
} as const;

export type PersonaUpstreamState = (typeof PersonaUpstreamState)[keyof typeof PersonaUpstreamState];

/**
 * `Pinned` holds one named character; `Sticky` follows whoever spoke here last and the server
 * writes it back. Both keep the current character in the same `personaId` field.
 */
export const AutoproxyMode = {
    Off: 'Off',
    Pinned: 'Pinned',
    Sticky: 'Sticky',
} as const;

export type AutoproxyMode = (typeof AutoproxyMode)[keyof typeof AutoproxyMode];

/** The account-level character: one row, however many guilds it is played in. */
export interface PersonaDto {
    id: string;
    scope: PersonaScope;
    ownerUserId?: string | null;
    ownerGuildId?: string | null;
    name: string;
    avatarUrl?: string | null;
    pronouns?: string | null;
    /** `#rrggbb`. Anything else is dropped by `safeAccentColor`. */
    color?: string | null;
    shortBio?: string | null;
    isRetired: boolean;
    createdAt: string;
}

/**
 * One guild's copy of a persona: the overrides, the proxy tags and the approval it carries here,
 * with the character itself nested. `PersonaGuildProfileDto` on the server. Every persona-profile
 * response is this shape, flat; nothing on the wire wraps the two halves in an outer object.
 */
export interface GuildPersonaDto {
    persona: PersonaDto;
    personaId: string;
    guildId: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    tag?: string | null;
    proxyPrefix?: string | null;
    proxySuffix?: string | null;
    wikiPageId?: string | null;
    upstreamRevisionNumber?: number | null;
    upstreamState?: PersonaUpstreamState;
    approvalState: PersonaApprovalState;
    approvedByUserId?: string | null;
    approvedAt?: string | null;
    changesRequestedReason?: string | null;
    /**
     * Resolved for the caller on this read, grants included. The `guild.PersonaProfileChanged`
     * event carries the profile's own answer instead, which cannot narrow it per reader.
     */
    canSpeak: boolean;
}

export interface PersonaGrantDto {
    id: string;
    personaId: string;
    roleId?: string | null;
    userId?: string | null;
}

/** Deleting a persona that has already spoken retires it instead. */
export interface PersonaDeletionDto {
    personaId: string;
    retired: boolean;
}

export interface ChannelAutoproxyDto {
    channelId: string;
    mode: AutoproxyMode;
    personaId?: string | null;
}

/** How a pull resolves the two sides. Sent verbatim; anything else fails to bind. */
export const PersonaPagePullStrategy = {
    /** Returns the diff and writes nothing. */
    Preview: 'Preview',
    /** Three-way merge that keeps local edits wherever the two sides disagree. */
    KeepLocal: 'KeepLocal',
    /** Discards local edits and takes the reference copy verbatim. */
    TakeUpstream: 'TakeUpstream',
} as const;

export type PersonaPagePullStrategy = (typeof PersonaPagePullStrategy)[keyof typeof PersonaPagePullStrategy];

/** One line the local copy and the reference copy both changed. */
export interface PersonaPageConflictDto {
    lineNumber: number;
    base?: string | null;
    local?: string | null;
    upstream?: string | null;
}

/** What a pull from the reference copy would change. `applied` is false for a preview. */
export interface PersonaPagePullDto {
    personaId: string;
    pageId?: string | null;
    applied: boolean;
    upstreamState: PersonaUpstreamState;
    upstreamRevisionNumber?: number | null;
    referenceRevisionNumber?: number | null;
    /** The merged body, so a preview shows exactly what applying would write. */
    mergedContent: string;
    mergedInfoboxJson?: string | null;
    /** Lines the two sides changed differently. Kept local, and listed here. */
    conflicts: PersonaPageConflictDto[];
}
