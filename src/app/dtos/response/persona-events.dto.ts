import {
    ChannelAutoproxyDto,
    PersonaApprovalState,
    PersonaPagePullStrategy,
    PersonaScope,
    PersonaUpstreamState,
} from './persona.dto';

export interface WsPersonaProfileChanged {
    guildId: string;
    personaId: string;
    approvalState: PersonaApprovalState;
    /** The profile's own state, broadcast guild-wide. Grants are not in it; only the GET resolves those. */
    canSpeak: boolean;
}

/**
 * The account-level row, as `guild.PersonaCreated` and `guild.PersonaUpdated` both carry it. One
 * copy per guild the character is adopted into, plus a guildless one for its owner, so a client
 * patches its cache rather than dropping it.
 */
export interface WsPersonaChanged {
    guildId?: string | null;
    personaId: string;
    scope: PersonaScope;
    name: string;
    avatarUrl?: string | null;
    pronouns?: string | null;
    color?: string | null;
    shortBio?: string | null;
    isRetired: boolean;
    updatedAt?: string | null;
}

export interface WsPersonaDeleted {
    guildId?: string | null;
    personaId: string;
    /** True when the character had already spoken, so the row was retired rather than removed. */
    retired: boolean;
}

/** A character joined the guild's cast. Display data, not the character itself. */
export interface WsPersonaAdopted {
    guildId: string;
    personaId: string;
    name: string;
    avatarUrl?: string | null;
    color?: string | null;
    tag?: string | null;
    wikiPageId?: string | null;
    approvalState: PersonaApprovalState;
    /** The profile's own state, same rule as {@link WsPersonaProfileChanged}. */
    canSpeak: boolean;
}

export interface WsPersonaUnadopted {
    guildId: string;
    personaId: string;
}

/** To the reviewers and to whoever answers for the character. Never guild-wide. */
export interface WsPersonaReviewRequested {
    guildId: string;
    personaId: string;
    name: string;
    wikiPageId?: string | null;
    approvalState: PersonaApprovalState;
    isResubmission: boolean;
    submittedAt?: string | null;
}

/** Same audience. The reason is reviewer feedback and rides this event alone. */
export interface WsPersonaReviewCompleted {
    guildId: string;
    personaId: string;
    name: string;
    approvalState: PersonaApprovalState;
    approved: boolean;
    reviewedByUserId: string;
    reviewedAt?: string | null;
    reason?: string | null;
    canSpeak: boolean;
}

/** `guild.PersonaGrantCreated` and `guild.PersonaGrantDeleted`, to the managers and the grantee. */
export interface WsPersonaGrantChanged {
    guildId: string;
    personaId: string;
    grantId: string;
    roleId?: string | null;
    userId?: string | null;
}

/** This guild's copy of a character page now exists. No wiki event goes out beside it. */
export interface WsPersonaPageCreated {
    guildId: string;
    personaId: string;
    pageId: string;
    title: string;
    categoryId?: string | null;
}

/** A character page was merged from its reference copy. A preview announces nothing. */
export interface WsPersonaPagePulled {
    guildId: string;
    personaId: string;
    pageId: string;
    strategy: PersonaPagePullStrategy;
    upstreamState: PersonaUpstreamState;
    upstreamRevisionNumber?: number | null;
    referenceRevisionNumber?: number | null;
    conflictCount?: number | null;
}

/** The caller's own autoproxy for one channel. Sticky moves it on send, so a second window hears. */
export interface WsAutoproxyChanged extends ChannelAutoproxyDto {
    guildId: string;
}
