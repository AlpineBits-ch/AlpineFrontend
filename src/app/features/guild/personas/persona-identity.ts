import {MessageDto} from '../../../dtos/response/message.dto';
import {GuildPersonaDto, PersonaDto, PersonaScope} from '../../../dtos/response/persona.dto';
import {readableAccent} from '../../../models/profile-font.model';

/** What a character looks like in one guild, once the overrides have been laid over the global row. */
export interface PersonaIdentity {
    personaId: string;
    name: string;
    avatarUrl: string | null;
    /** Appended after the name, PluralKit's servertag. */
    tag: string | null;
    color: string | null;
    pronouns: string | null;
    initial: string;
    isRetired: boolean;
}

export function personaInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
}

/**
 * Display fields carried beside a persona id. The guild cast lists only what the caller may speak
 * as, so anything naming somebody else's character has to bring its own copy, the way a message does.
 */
export interface PersonaDisplayHint {
    name?: string | null;
    avatarUrl?: string | null;
    color?: string | null;
    tag?: string | null;
}

export function identityFromHint(
    personaId: string,
    hint: PersonaDisplayHint | null | undefined,
): PersonaIdentity | null {
    if (!hint?.name) return null;
    return {
        personaId,
        name: hint.name,
        avatarUrl: hint.avatarUrl ?? null,
        tag: hint.tag ?? null,
        color: readableAccent(hint.color),
        pronouns: null,
        initial: personaInitial(hint.name),
        isRetired: false,
    };
}

/** The global row on its own, for the account-level list where no guild is in scope. */
export function globalIdentity(persona: PersonaDto): PersonaIdentity {
    return {
        personaId: persona.id,
        name: persona.name,
        avatarUrl: persona.avatarUrl ?? null,
        tag: null,
        color: readableAccent(persona.color),
        pronouns: persona.pronouns ?? null,
        initial: personaInitial(persona.name),
        isRetired: persona.isRetired,
    };
}

export function personaIdentity(entry: GuildPersonaDto): PersonaIdentity {
    const base = globalIdentity(entry.persona);
    return {
        ...base,
        name: entry.displayName || base.name,
        avatarUrl: entry.avatarUrl || base.avatarUrl,
        tag: entry.tag || null,
        initial: personaInitial(entry.displayName || base.name),
    };
}

/** Whether a field is answered here or inherited. Drives the "Using the global name" hints. */
export type OverrideState = 'inherited' | 'overridden';

export function overrideState(value: string | null | undefined): OverrideState {
    return value ? 'overridden' : 'inherited';
}

/** Speakable here: not retired, and the caller holds ownership or a grant. */
export function canSpeakAs(entry: GuildPersonaDto): boolean {
    return !entry.persona.isRetired && entry.canSpeak;
}

export function isGuildScoped(persona: PersonaDto): boolean {
    return persona.scope === PersonaScope.Guild;
}

/**
 * How a persona message renders. The overrides are denormalised on the message, so this reads them
 * rather than the persona: editing a character never rewrites what it already said.
 */
export interface MessageAuthorIdentity {
    /** The name on the message header. */
    name: string | null;
    avatarUrl: string | null;
    /** Null for a webhook, which carries the overrides without a character behind them. */
    personaId: string | null;
    inCharacter: boolean;
}

export function messageAuthorIdentity(message: MessageDto): MessageAuthorIdentity {
    return {
        name: message.authorDisplayName ?? null,
        avatarUrl: message.authorAvatarUrl ?? null,
        personaId: message.personaId ?? null,
        inCharacter: !!message.personaId,
    };
}

/**
 * Two messages are one block only when the same character spoke both. Without the persona in the
 * comparison, switching character inside the grouping window hides the second character entirely.
 */
export function sameSpeaker(a: MessageDto, b: MessageDto): boolean {
    return a.authorId === b.authorId && (a.personaId ?? null) === (b.personaId ?? null);
}

/** A cover gradient built from the character's own colour, for a page that has no cover image. */
export function personaCoverGradient(color: string | null): string {
    const accent = color ?? 'var(--color-brand)';
    return `linear-gradient(135deg, color-mix(in srgb, ${accent} 42%, var(--color-app-bg)) 0%, color-mix(in srgb, ${accent} 12%, var(--color-app-bg)) 55%, var(--color-app-bg) 100%)`;
}

export function sortPersonas(entries: readonly GuildPersonaDto[]): GuildPersonaDto[] {
    return [...entries].sort((a, b) => {
        if (a.persona.isRetired !== b.persona.isRetired) return a.persona.isRetired ? 1 : -1;
        return personaIdentity(a).name.localeCompare(personaIdentity(b).name);
    });
}

/** Search over everything a person might type to find a character mid-scene. */
export function matchesPersonaQuery(entry: GuildPersonaDto, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const identity = personaIdentity(entry);
    const haystack = [
        identity.name,
        entry.persona.name,
        identity.tag,
        entry.proxyPrefix,
        entry.proxySuffix,
        entry.persona.pronouns,
    ];

    return haystack.some(value => value?.toLowerCase().includes(needle));
}
