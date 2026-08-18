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

    // ── Local only. The server sends none of these; `notePost` fills lastPostAt. ───
    /** When the last post landed, as a fallback for a turn with no `turnStartedAt`. */
    lastPostAt?: string | null;
    createdAt?: string | null;
    concludedAt?: string | null;
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

/** `guild.SceneUpdated`: status, cast or rotation moved. Carries no display data for the cast. */
export interface SceneUpdatedDto {
    guildId: string;
    channelId: string;
    status: SceneStatus;
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
