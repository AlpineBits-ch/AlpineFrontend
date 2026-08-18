import {DiceTermDto} from '../../../dtos/response/dice.dto';

/** The server refuses anything past these before it rolls, so the tray refuses it first. */
export const DICE_LIMITS = {
    expressionLength: 128,
    terms: 16,
    dicePerTerm: 100,
    diceTotal: 100,
    minSides: 2,
    maxSides: 1000,
    maxConstant: 1_000_000,
    explosionChain: 10,
} as const;

export type KeepMode = 'kh' | 'kl' | 'dh' | 'dl';

/** One parsed term. A constant carries `constant`; a pool carries the rest. */
export interface DiceTermSpec {
    notation: string;
    sign: 1 | -1;
    constant: number | null;
    count: number;
    sides: number;
    explode: boolean;
    keep: {mode: KeepMode; n: number} | null;
    /** Set when the term was written `adv` or `dis`, so it normalises back to the word. */
    advantage: 'adv' | 'dis' | null;
}

export interface ParsedExpression {
    /** Normalised the way the server would write it back. */
    expression: string;
    terms: DiceTermSpec[];
    totalDice: number;
}

export interface DiceParseError {
    ok: false;
    /** A `DICE.ERROR.*` key. */
    key: string;
    params?: Record<string, string | number>;
}

export type DiceParseResult = {ok: true; value: ParsedExpression} | DiceParseError;

const KEEP_MODES: readonly KeepMode[] = ['kh', 'kl', 'dh', 'dl'];

function fail(key: string, params?: Record<string, string | number>): DiceParseError {
    return {ok: false, key: `DICE.ERROR.${key}`, params};
}

/** How many dice a keep or drop mode leaves standing. */
export function keptCount(spec: DiceTermSpec): number {
    if (!spec.keep) return spec.count;
    const {mode, n} = spec.keep;
    return mode === 'kh' || mode === 'kl' ? Math.min(n, spec.count) : Math.max(spec.count - n, 0);
}

function normaliseTerm(spec: DiceTermSpec): string {
    if (spec.constant !== null) return String(spec.constant);
    const count = spec.advantage ? '' : spec.count === 1 ? '' : String(spec.count);
    const head = spec.advantage ? `${spec.count}d${spec.sides}` : `${count}d${spec.sides}`;
    const keep = spec.advantage ?? (spec.keep ? `${spec.keep.mode}${spec.keep.n}` : '');
    return `${head}${keep}${spec.explode ? '!' : ''}`;
}

function parseTerm(raw: string, sign: 1 | -1): DiceTermSpec | DiceParseError {
    if (/^\d+$/.test(raw)) {
        const constant = Number(raw);
        if (constant > DICE_LIMITS.maxConstant) {
            return fail('CONSTANT', {max: DICE_LIMITS.maxConstant.toLocaleString()});
        }
        return {
            notation: raw,
            sign,
            constant,
            count: 0,
            sides: 0,
            explode: false,
            keep: null,
            advantage: null,
        };
    }

    const pool = /^(\d*)d(\d+)(.*)$/.exec(raw);
    if (!pool) return fail('SYNTAX', {part: raw});

    const [, countText, sidesText, modifiersText] = pool;
    const sides = Number(sidesText);
    if (sides === 1) return fail('D1');
    if (sides < DICE_LIMITS.minSides || sides > DICE_LIMITS.maxSides) {
        return fail('SIDES', {min: DICE_LIMITS.minSides, max: DICE_LIMITS.maxSides});
    }

    let count = countText === '' ? 1 : Number(countText);
    if (count < 1) return fail('SYNTAX', {part: raw});
    if (count > DICE_LIMITS.dicePerTerm) return fail('TOO_MANY_DICE', {max: DICE_LIMITS.diceTotal});

    let explode = false;
    let keep: {mode: KeepMode; n: number} | null = null;
    let advantage: 'adv' | 'dis' | null = null;
    let rest = modifiersText;

    while (rest.length) {
        if (rest.startsWith('!')) {
            explode = true;
            rest = rest.slice(1);
            continue;
        }

        const word = rest.startsWith('adv') ? 'adv' : rest.startsWith('dis') ? 'dis' : null;
        if (word) {
            if (keep) return fail('KEEP_CONFLICT');
            advantage = word;
            keep = {mode: word === 'adv' ? 'kh' : 'kl', n: 1};
            // Keeping the highest of one die changes nothing, so a single die is raised to two.
            if (count === 1) count = 2;
            rest = rest.slice(3);
            continue;
        }

        const mode = KEEP_MODES.find(m => rest.startsWith(m));
        if (!mode) return fail('SYNTAX', {part: raw});
        if (keep) return fail('KEEP_CONFLICT');
        rest = rest.slice(mode.length);
        const digits = /^\d*/.exec(rest)?.[0] ?? '';
        rest = rest.slice(digits.length);
        const n = digits === '' ? 1 : Number(digits);
        if (n < 1 || n > count) return fail('KEEP_COUNT', {count});
        keep = {mode, n};
    }

    const spec: DiceTermSpec = {notation: '', sign, constant: null, count, sides, explode, keep, advantage};
    spec.notation = normaliseTerm(spec);
    return spec;
}

/** Parses and bounds-checks an expression without rolling it. */
export function parseDiceExpression(input: string): DiceParseResult {
    const cleaned = input.replace(/\s+/g, '').toLowerCase();
    if (!cleaned) return fail('EMPTY');
    if (input.length > DICE_LIMITS.expressionLength) {
        return fail('TOO_LONG', {max: DICE_LIMITS.expressionLength});
    }

    const terms: DiceTermSpec[] = [];
    let cursor = 0;
    let sign: 1 | -1 = 1;

    while (cursor < cleaned.length) {
        const char = cleaned[cursor];
        if (char === '+' || char === '-') {
            if (terms.length === 0 && cursor > 0) return fail('SYNTAX', {part: cleaned});
            sign = char === '-' ? -1 : 1;
            cursor += 1;
        } else if (terms.length > 0) {
            return fail('SYNTAX', {part: cleaned.slice(cursor)});
        }

        let end = cursor;
        while (end < cleaned.length && cleaned[end] !== '+' && cleaned[end] !== '-') end += 1;
        const raw = cleaned.slice(cursor, end);
        if (!raw) return fail('SYNTAX', {part: cleaned});

        const parsed = parseTerm(raw, sign);
        if ('ok' in parsed) return parsed;
        terms.push(parsed);
        if (terms.length > DICE_LIMITS.terms) return fail('TOO_MANY_TERMS', {max: DICE_LIMITS.terms});
        cursor = end;
        sign = 1;
    }

    const totalDice = terms.reduce((sum, term) => sum + term.count, 0);
    if (totalDice > DICE_LIMITS.diceTotal) return fail('TOO_MANY_DICE', {max: DICE_LIMITS.diceTotal});

    const expression = terms
        .map((term, index) =>
            index === 0
                ? `${term.sign === -1 ? '-' : ''}${term.notation}`
                : `${term.sign === -1 ? '- ' : '+ '}${term.notation}`,
        )
        .join(' ');

    return {ok: true, value: {expression, terms, totalDice}};
}

function randomFace(sides: number): number {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return (buffer[0] % sides) + 1;
}

/** Rolls a parsed expression. Only the mock calls this; a real roll is the server's. */
export function rollParsed(parsed: ParsedExpression): {
    total: number;
    terms: DiceTermDto[];
    breakdown: string;
} {
    const terms: DiceTermDto[] = parsed.terms.map(spec => {
        if (spec.constant !== null) {
            return {
                notation: spec.notation,
                sign: spec.sign,
                constant: spec.constant,
                dice: [],
                kept: [],
                subtotal: spec.constant,
            };
        }

        const dice: number[] = [];
        for (let i = 0; i < spec.count; i += 1) {
            let value = randomFace(spec.sides);
            let face = value;
            let chain = 0;
            while (spec.explode && face === spec.sides && chain < DICE_LIMITS.explosionChain) {
                face = randomFace(spec.sides);
                value += face;
                chain += 1;
            }
            dice.push(value);
        }

        const kept = keptDice(dice, spec);
        return {
            notation: spec.notation,
            sign: spec.sign,
            constant: null,
            dice,
            kept,
            subtotal: kept.reduce((sum, value) => sum + value, 0),
        };
    });

    const total = terms.reduce((sum, term) => sum + term.sign * term.subtotal, 0);
    return {total, terms, breakdown: buildBreakdown(terms)};
}

/** Which dice counted, honouring the keep or drop mode. */
export function keptDice(dice: readonly number[], spec: DiceTermSpec): number[] {
    if (!spec.keep) return [...dice];
    const ordered = dice.map((value, index) => ({value, index}));
    const highFirst = [...ordered].sort((a, b) => b.value - a.value || a.index - b.index);
    const lowFirst = [...ordered].sort((a, b) => a.value - b.value || a.index - b.index);
    const {mode, n} = spec.keep;

    const chosen =
        mode === 'kh'
            ? highFirst.slice(0, n)
            : mode === 'kl'
              ? lowFirst.slice(0, n)
              : mode === 'dh'
                ? highFirst.slice(n)
                : lowFirst.slice(n);

    const keptIndexes = new Set(chosen.map(entry => entry.index));
    return ordered.filter(entry => keptIndexes.has(entry.index)).map(entry => entry.value);
}

/** The plain-text line, with a dropped die marked `~`. */
export function buildBreakdown(terms: readonly DiceTermDto[]): string {
    return terms
        .map((term, index) => {
            const lead = index === 0 ? (term.sign === -1 ? '-' : '') : term.sign === -1 ? ' - ' : ' + ';
            if (term.constant !== null && term.constant !== undefined) return `${lead}${term.constant}`;
            const remaining = [...term.kept];
            const faces = term.dice.map(value => {
                const at = remaining.indexOf(value);
                if (at === -1) return `~${value}`;
                remaining.splice(at, 1);
                return String(value);
            });
            return `${lead}${term.notation} (${faces.join(', ')})`;
        })
        .join('');
}
