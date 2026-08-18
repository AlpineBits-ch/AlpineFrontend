import {AutoproxyMode, PersonaPagePullStrategy} from '../response/persona.dto';

export interface CreatePersonaDto {
    name: string;
    avatarUrl?: string | null;
    pronouns?: string | null;
    color?: string | null;
    shortBio?: string | null;
}

export type UpdatePersonaDto = Partial<CreatePersonaDto> & {isRetired?: boolean};

/** Adopts the persona into the guild when no profile exists yet, and sets the overrides either way. */
export interface UpsertPersonaProfileDto {
    displayName?: string | null;
    avatarUrl?: string | null;
    tag?: string | null;
    proxyPrefix?: string | null;
    proxySuffix?: string | null;
}

/** Exactly one of the two. */
export interface CreatePersonaGrantDto {
    roleId?: string;
    userId?: string;
}

export interface RequestPersonaChangesDto {
    reason: string;
}

export interface SetAutoproxyDto {
    mode: AutoproxyMode;
    /** Required for `Pinned`; a starting value for `Sticky`; ignored for `Off`. */
    personaId?: string | null;
}

export interface PullPersonaPageDto {
    strategy: PersonaPagePullStrategy;
}
