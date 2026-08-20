import {SceneStatus} from '../response/scene.dto';

/** The folder filter value that means "filed nowhere". A real folder id never collides with it. */
export const UNFILED = 'unfiled';

export type SceneSort = 'board' | 'name' | 'ended';

/**
 * Query for `GET /guilds/{id}/scenes`. The server excludes concluded and archived scenes unless
 * asked, so a caller that omits the flags gets the live board and nothing else.
 */
export interface SceneListParams {
    waitingOnMe?: boolean;
    includeConcluded?: boolean;
    includeArchived?: boolean;
    /** Only scenes that finished, or whose channel was archived. What the archive asks for. */
    archivedOnly?: boolean;
    /** A folder id, or `UNFILED`. */
    folderId?: string | null;
    /** ANDed: a scene must carry every one of them. */
    tagIds?: string[];
    /** Scene name only. Never message content. */
    q?: string;
    sort?: SceneSort;
    offset?: number;
    limit?: number;
}

/** Creates the scene thread and its OOC companion in one call. */
export interface CreateSceneDto {
    name: string;
    description?: string | null;
    /** The cast. Omitting it takes the cast from `turnOrder`. */
    participantPersonaIds?: string[];
    /** Personas, in turn order. The first one is up when the scene opens. */
    turnOrder: string[];
    /** Whole hours. Absent means the scene runs without a clock. */
    turnLengthHours?: number | null;
    /** Scenes usually open `Open` and are started once the cast has arrived. */
    status?: SceneStatus;
}

export interface CreateSceneFolderDto {
    name: string;
    parentFolderId?: string | null;
    /** A single emoji. */
    icon?: string | null;
    color?: string | null;
}

/** Every field is optional and an omitted one is left alone. */
export interface UpdateSceneFolderDto {
    name?: string;
    /** Empty string moves it to the root; omitting it leaves it where it is. */
    parentFolderId?: string;
    /** Empty string clears it. */
    icon?: string;
    color?: string;
}

export interface ReorderSceneFoldersDto {
    /** Every folder in the guild, exactly once. Position comes from the index. */
    folderIds: string[];
}

export interface CreateSceneTagDto {
    name: string;
    color?: string | null;
    emojiId?: string | null;
    emojiName?: string | null;
    moderated?: boolean;
}

export interface UpdateSceneTagDto {
    name?: string;
    color?: string;
    /** Empty string clears the emoji. */
    emojiId?: string;
    emojiName?: string;
    moderated?: boolean;
}

/** Replaces a scene's whole tag set, so removing one is the same call as adding one. */
export interface SetSceneTagsDto {
    tagIds: string[];
}

export interface UpdateSceneDto {
    status?: SceneStatus;
    /**
     * Files the scene on a shelf. Omit the key to leave it alone, send null to unfile. The two are
     * different requests, so this must never be spread in from an object with the key present.
     */
    folderId?: string | null;
    /** Replaces the cast. A character it drops leaves the scene. */
    participantPersonaIds?: string[];
    /** Checked against the cast as this same call leaves it. */
    turnOrder?: string[];
    turnLengthHours?: number | null;
    /** Sent when concluding. */
    conclusionNote?: string | null;
}

export interface AddSceneParticipantDto {
    personaId: string;
    /** Where in the queue. Appended when absent. */
    position?: number | null;
}

/** Passing without posting. The reason is shown in the timeline where the turn would have been. */
export interface AdvanceTurnDto {
    reason?: string | null;
}

/** The GM moving a turn along. Distinct from advancing: somebody else's turn is being ended. */
export interface SkipTurnDto {
    reason?: string | null;
}
