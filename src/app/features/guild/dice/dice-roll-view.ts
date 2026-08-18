import {DiceEmbedPayload, DiceTermDto} from '../../../dtos/response/dice.dto';
import {MessageDto} from '../../../dtos/response/message.dto';

/** One die as it is drawn: the face it settled on, and whether it counted. */
export interface DieFace {
    value: number;
    kept: boolean;
    /** The die showed its highest face. Marked for any die size, not just a d20. */
    isMax: boolean;
    isMin: boolean;
    /** Exploded past its own maximum, so the face is a sum rather than a roll. */
    exploded: boolean;
}

export interface DiceTermView {
    notation: string;
    sign: 1 | -1;
    constant: number | null;
    faces: DieFace[];
    subtotal: number;
    /** Die sides, read back off the notation. Zero when it cannot be. */
    sides: number;
}

export interface DiceRollView {
    expression: string;
    total: number;
    breakdown: string;
    reason: string | null;
    terms: DiceTermView[];
    /** One pool, no modifiers: the die face is the headline and nothing else is needed. */
    isSingleDie: boolean;
    diceCount: number;
}

function sidesOf(notation: string): number {
    return Number(/d(\d+)/i.exec(notation)?.[1] ?? 0);
}

function facesOf(term: DiceTermDto, sides: number): DieFace[] {
    const remaining = [...(term.kept ?? [])];
    return (term.dice ?? []).map(value => {
        const at = remaining.indexOf(value);
        const kept = at !== -1;
        if (kept) remaining.splice(at, 1);
        return {
            value,
            kept,
            isMax: sides > 0 && value === sides,
            isMin: sides > 0 && value === 1,
            exploded: sides > 0 && value > sides,
        };
    });
}

export function diceRollView(payload: DiceEmbedPayload): DiceRollView {
    const terms: DiceTermView[] = (payload.terms ?? []).map(term => {
        const sides = sidesOf(term.notation);
        return {
            notation: term.notation,
            sign: term.sign === -1 ? -1 : 1,
            constant: term.constant ?? null,
            faces: facesOf(term, sides),
            subtotal: term.subtotal,
            sides,
        };
    });

    const diceCount = terms.reduce((sum, term) => sum + term.faces.length, 0);
    return {
        expression: payload.expression,
        total: payload.total,
        breakdown: payload.breakdown,
        reason: payload.reason ?? null,
        terms,
        isSingleDie: diceCount === 1 && terms.length === 1,
        diceCount,
    };
}

/**
 * The structured roll off a `DiceRoll` message, or null when it cannot be read. A null is not an
 * error: `content` already carries the same result as text, which is what an older client shows.
 */
export function diceRollFromMessage(message: MessageDto): DiceRollView | null {
    if (!message.embedsJson) return null;
    try {
        const embeds = JSON.parse(message.embedsJson) as {dice?: DiceEmbedPayload; title?: string}[];
        const found = embeds?.find(embed => Array.isArray(embed?.dice?.terms));
        if (!found?.dice) return null;
        const view = diceRollView(found.dice);
        return {...view, reason: view.reason ?? found.title ?? null};
    } catch {
        return null;
    }
}
