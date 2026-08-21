/**
 * A scene is a thread with turn order. The board reads `SceneListItemDto`, the channel reads the
 * whole `SceneDto`; the two are different shapes on the wire and are cached separately.
 */
export const SceneStatus = {
    /** Cast is being assembled. Nobody's turn yet. */
    Open: 'Open',
    Active: 'Active',
    Paused: 'Paused',
    Concluded: 'Concluded',
} as const;

export type SceneStatus = (typeof SceneStatus)[keyof typeof SceneStatus];

/** Whether a character can walk into the scene or has to be let in. */
export const SceneJoinPolicy = {
    Open: 'Open',
    Ask: 'Ask',
} as const;

export type SceneJoinPolicy = (typeof SceneJoinPolicy)[keyof typeof SceneJoinPolicy];

/** Who the scene exists for. `Cast` hides it from everyone else, its OOC thread included. */
export const SceneVisibility = {
    Everyone: 'Everyone',
    Cast: 'Cast',
} as const;

export type SceneVisibility = (typeof SceneVisibility)[keyof typeof SceneVisibility];

export const SceneJoinRequestStatus = {
    Pending: 'Pending',
    Approved: 'Approved',
    Denied: 'Denied',
    Withdrawn: 'Withdrawn',
} as const;

export type SceneJoinRequestStatus = (typeof SceneJoinRequestStatus)[keyof typeof SceneJoinRequestStatus];

export interface SceneParticipantDto {
    personaId: string;
    /** The per-guild display name. Empty for a character the guild no longer adopts. */
    name?: string | null;
    avatarUrl?: string | null;
    color?: string | null;
    tag?: string | null;
    isRetired?: boolean;
    /** The owner declared an absence, so the rotation steps over this turn rather than stalling. */
    isAway?: boolean;
    isCurrentTurn?: boolean;
}

export interface SceneDto {
    /** The scene channel's id, which is also the key of its turn state. */
    channelId: string;
    guildId: string;
    name: string;
    parentChannelId?: string | null;
    createdByUserId?: string | null;
    isArchived?: boolean;
    status: SceneStatus;
    /** Absent from a server that predates the access settings, where every scene is an open table. */
    joinPolicy?: SceneJoinPolicy;
    visibility?: SceneVisibility;
    /** The cast, ids only. `participants` is the same set with the display data attached. */
    participantPersonaIds?: string[];
    /** Persona ids, in the order they take turns. Empty means the cast as it was assembled. */
    turnOrder: string[];
    participants: SceneParticipantDto[];
    currentTurnPersonaId?: string | null;
    turnStartedAt?: string | null;
    turnDeadlineAt?: string | null;
    turnLengthHours?: number | null;
    turnNumber?: number | null;
    postCount?: number | null;
    conclusionNote?: string | null;
    oocThreadId?: string | null;
    /** How many times the current turn has been chased. Two is when the GM hears about it. */
    nudgeCount?: number | null;
    /** The cast the rotation is stepping over. Characters, never players. */
    awayPersonaIds?: string[];
    /** The archive shelf this scene is filed on. Null means unfiled. */
    folderId?: string | null;
    tagIds?: string[];
    createdAt?: string | null;
    /** Null on a scene still running, and on one that ended before the column did. */
    concludedAt?: string | null;

    // ── Local only. The server does not send this; `notePost` fills it. ───────
    /** When the last post landed, as a fallback for a turn with no `turnStartedAt`. */
    lastPostAt?: string | null;
}

/**
 * One row of the guild's scene board. Lighter than a scene: a count instead of the cast, and the
 * character on the clock already named, so a board of twenty rows costs one call.
 */
export interface SceneListItemDto {
    channelId: string;
    name: string;
    parentChannelId?: string | null;
    status: SceneStatus;
    joinPolicy?: SceneJoinPolicy;
    visibility?: SceneVisibility;
    currentTurnPersonaId?: string | null;
    currentTurnName?: string | null;
    currentTurnAvatarUrl?: string | null;
    currentTurnColor?: string | null;
    turnStartedAt?: string | null;
    turnDeadlineAt?: string | null;
    turnNumber?: number | null;
    postCount?: number | null;
    /**
     * The server's answer for the calling user. The client resolves it from the speakable cast
     * instead, so revoking a grant reorders the board without a refetch.
     */
    isWaitingOnMe?: boolean;
    participantCount?: number | null;
    oocThreadId?: string | null;
    nudgeCount?: number | null;
    updatedAt?: string | null;
    /** The archive shelf this scene is filed on. Null means unfiled. */
    folderId?: string | null;
    tagIds?: string[];
    /** Null on a scene still running, and on one that ended before the column did. */
    concludedAt?: string | null;
    createdAt?: string | null;
}

/** `GET /guilds/{id}/scenes`. Not a bare array. */
export interface SceneListDto {
    scenes: SceneListItemDto[];
    /** True when more scenes matched than the route returns. */
    truncated: boolean;
}

/** `guild.SceneTurnNudge`, as the guild hub sends it. */
export interface SceneTurnNudgeDto {
    guildId: string;
    channelId: string;
    /** Who the scene is waiting on. Never the owning account. */
    personaId: string;
    /** The scene's name, so a nudge for a forgotten game names the game. */
    sceneName?: string | null;
    turnStartedAt?: string | null;
    turnDeadlineAt?: string | null;
    turnNumber?: number | null;
    /** How many times this turn has been chased. Two or more is the GM escalation. */
    nudgeCount?: number | null;
    /** True when this arrived because the caller holds `ManageScenes`, not because it is their turn. */
    escalated?: boolean;
}

/** `guild.SceneTurnChanged`: the turn moved. A patch, not the whole scene. */
export interface SceneTurnChangedDto {
    guildId: string;
    channelId: string;
    /** Whose turn it was, so a client can render the handover. */
    previousPersonaId?: string | null;
    currentTurnPersonaId?: string | null;
    turnStartedAt?: string | null;
    turnDeadlineAt?: string | null;
    turnNumber?: number | null;
    status: SceneStatus;
}

/** One shelf of the guild's scene archive. Nests two deep, never more. */
export interface SceneFolderDto {
    id: string;
    guildId: string;
    name: string;
    position: number;
    parentFolderId?: string | null;
    /** A single emoji shown on the rail row. */
    icon?: string | null;
    color?: string | null;
}

/** A label applied to scenes. `ForumTag` in every respect but scope. */
export interface SceneTagDto {
    id: string;
    guildId: string;
    name: string;
    /** `#000000` is the server's "no colour chosen" default, not real black. */
    color: string;
    emojiId?: string | null;
    emojiName?: string | null;
    position: number;
    /** Only a ManageScenes holder may apply or remove it. */
    moderated: boolean;
}

/**
 * The guild's whole archive vocabulary. Read and replaced as one set, which is why
 * `guild.SceneTaxonomyChanged` carries all of it rather than a delta.
 */
export interface SceneTaxonomyDto {
    guildId: string;
    folders: SceneFolderDto[];
    tags: SceneTagDto[];
}

/** `guild.SceneTagsChanged`: one scene's labels were rewritten. */
export interface SceneTagsChangedDto {
    guildId: string;
    channelId: string;
    tagIds: string[];
}

/** `guild.SceneUpdated`: status, cast or rotation moved. Carries no display data for the cast. */
export interface SceneUpdatedDto {
    guildId: string;
    channelId: string;
    status: SceneStatus;
    joinPolicy?: SceneJoinPolicy;
    visibility?: SceneVisibility;
    folderId?: string | null;
    participantPersonaIds?: string[];
    turnOrder?: string[];
    currentTurnPersonaId?: string | null;
    turnStartedAt?: string | null;
    turnDeadlineAt?: string | null;
    turnNumber?: number | null;
    postCount?: number | null;
    conclusionNote?: string | null;
    oocThreadId?: string | null;
}

/** `guild.SceneCreated`: a game started. Enough to put a row on the board without a read. */
export interface SceneCreatedDto {
    guildId: string;
    channelId: string;
    parentChannelId?: string | null;
    name: string;
    oocThreadId?: string | null;
    status: SceneStatus;
    joinPolicy?: SceneJoinPolicy;
    visibility?: SceneVisibility;
    participantPersonaIds?: string[];
    turnOrder?: string[];
    currentTurnPersonaId?: string | null;
    turnStartedAt?: string | null;
    turnDeadlineAt?: string | null;
    turnNumber?: number | null;
    turnLengthHours?: number | null;
}

/** `guild.SceneConcluded`: the scene finished for good. What a client stops nudging on. */
export interface SceneConcludedDto {
    guildId: string;
    channelId: string;
    status: SceneStatus;
    conclusionNote?: string | null;
    turnNumber?: number | null;
    postCount?: number | null;
    concludedAt?: string | null;
}

/**
 * One character waiting on a GM. Carries its own display fields, the way a message does: the
 * caller may hold no grant on the character and so never sees it in the guild cast.
 */
export interface SceneJoinRequestDto {
    id: string;
    guildId: string;
    sceneChannelId: string;
    personaId: string;
    /** The per-guild display name. Empty for a character the guild no longer adopts. */
    personaName: string;
    personaAvatarUrl?: string | null;
    personaColor?: string | null;
    /** Who asked. Named here because approving is a decision about a member, not about a character. */
    requestedByUserId: string;
    note?: string | null;
    status: SceneJoinRequestStatus;
    decidedByUserId?: string | null;
    decidedAt?: string | null;
    decisionReason?: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Both join-request reads answer this envelope, not a bare array. */
export interface SceneJoinRequestListDto {
    requests: SceneJoinRequestDto[];
}

/** `guild.SceneJoinRequested`: somebody wants a character in a closed scene. GMs only. */
export interface SceneJoinRequestedDto {
    guildId: string;
    channelId: string;
    requestId: string;
    personaId: string;
    personaName?: string | null;
    personaAvatarUrl?: string | null;
    personaColor?: string | null;
    requestedByUserId: string;
    note?: string | null;
    createdAt: string;
}

/** `guild.SceneJoinRequestResolved`: the answer. `decisionReason` travels on this event only. */
export interface SceneJoinRequestResolvedDto {
    guildId: string;
    channelId: string;
    requestId: string;
    personaId: string;
    status: SceneJoinRequestStatus;
    decisionReason?: string | null;
    decidedByUserId?: string | null;
}
