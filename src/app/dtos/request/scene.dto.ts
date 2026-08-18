import {SceneStatus} from '../response/scene.dto';

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

export interface UpdateSceneDto {
    status?: SceneStatus;
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
