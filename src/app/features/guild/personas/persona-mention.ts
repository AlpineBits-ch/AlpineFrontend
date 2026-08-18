import {PersonaDisplayHint} from './persona-identity';

/**
 * Mentioning a character notifies the player behind it and never names them. That rule is why the
 * body carries an id rather than a name: a name would have to be resolved against somebody, and the
 * only thing on hand to resolve against is the account.
 */
export const PERSONA_MENTION_SOURCE = '<@(pers_[A-Za-z0-9_-]{1,64})>';

export function personaMentionPattern(): RegExp {
    return new RegExp(PERSONA_MENTION_SOURCE, 'g');
}

export function personaMentionToken(personaId: string): string {
    return `<@${personaId}>`;
}

export function isPersonaId(value: string | null | undefined): boolean {
    return !!value && /^pers_[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** Every character named in a body, in the order they appear, without repeats. */
export function personaMentionIds(content: string): string[] {
    const found = new Set<string>();
    for (const match of content.matchAll(personaMentionPattern())) found.add(match[1]);
    return [...found];
}

/** Display fields carried beside a persona mention, for a character the reader cannot speak as. */
export interface PersonaMentionDto extends PersonaDisplayHint {
    personaId: string;
}
