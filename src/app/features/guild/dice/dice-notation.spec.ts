import {describe, expect, it} from 'vitest';
import {buildBreakdown, DICE_LIMITS, keptDice, parseDiceExpression, rollParsed} from './dice-notation';

function parse(input: string) {
    const result = parseDiceExpression(input);
    if (!result.ok) throw new Error(`expected ${input} to parse, got ${result.key}`);
    return result.value;
}

function failure(input: string): string {
    const result = parseDiceExpression(input);
    if (result.ok) throw new Error(`expected ${input} to be refused`);
    return result.key;
}

describe('parseDiceExpression', () => {
    it('defaults the count to one', () => {
        const {terms} = parse('d20');
        expect(terms).toHaveLength(1);
        expect(terms[0].count).toBe(1);
        expect(terms[0].sides).toBe(20);
    });

    it('reads arithmetic between terms, including a leading minus', () => {
        const {terms} = parse('3d6+2d4-1');
        expect(terms.map(t => [t.sign, t.count, t.sides, t.constant])).toEqual([
            [1, 3, 6, null],
            [1, 2, 4, null],
            [-1, 0, 0, 1],
        ]);
    });

    it('ignores whitespace and case', () => {
        expect(parse('4D6 KH3 + 2').expression).toBe(parse('4d6kh3+2').expression);
    });

    it('raises advantage on a single die to two, since keeping one of one changes nothing', () => {
        const {terms} = parse('1d20adv');
        expect(terms[0].count).toBe(2);
        expect(terms[0].keep).toEqual({mode: 'kh', n: 1});
        expect(terms[0].notation).toBe('2d20adv');
    });

    it('leaves advantage on a pool of two alone', () => {
        expect(parse('2d20adv').terms[0].count).toBe(2);
    });

    it('normalises the way the server writes it back', () => {
        expect(parse('4d6kh3+2').expression).toBe('4d6kh3 + 2');
        expect(parse('3d6-1').expression).toBe('3d6 - 1');
    });

    it('takes the four keep and drop modes, defaulting the count to one', () => {
        expect(parse('4d6dl').terms[0].keep).toEqual({mode: 'dl', n: 1});
        expect(parse('4d6dh2').terms[0].keep).toEqual({mode: 'dh', n: 2});
        expect(parse('4d6kl1').terms[0].keep).toEqual({mode: 'kl', n: 1});
    });

    it('takes an exploding pool', () => {
        expect(parse('1d10!').terms[0].explode).toBe(true);
    });

    describe('bounds, all of which the server refuses too', () => {
        it('refuses a d1, which would never stop exploding', () => {
            expect(failure('1d1')).toBe('DICE.ERROR.D1');
        });

        it('refuses a die outside two to a thousand sides', () => {
            expect(failure('1d1001')).toBe('DICE.ERROR.SIDES');
        });

        it('refuses more than a hundred dice, in one term or across the expression', () => {
            expect(failure('101d6')).toBe('DICE.ERROR.TOO_MANY_DICE');
            expect(failure('60d6+60d6')).toBe('DICE.ERROR.TOO_MANY_DICE');
        });

        it('refuses an expression past the length cap', () => {
            expect(failure('1d6+'.repeat(40) + '1')).toBe('DICE.ERROR.TOO_LONG');
        });

        it('refuses a constant past a million', () => {
            expect(failure('1000001')).toBe('DICE.ERROR.CONSTANT');
        });

        it('refuses two keep or drop modes in one term', () => {
            expect(failure('4d6kh3kl1')).toBe('DICE.ERROR.KEEP_CONFLICT');
            expect(failure('4d6advkh1')).toBe('DICE.ERROR.KEEP_CONFLICT');
        });

        it('refuses keeping more dice than the term rolls', () => {
            expect(failure('2d6kh5')).toBe('DICE.ERROR.KEEP_COUNT');
        });

        it('refuses nonsense rather than guessing at it', () => {
            expect(failure('hello')).toBe('DICE.ERROR.SYNTAX');
            expect(failure('2d')).toBe('DICE.ERROR.SYNTAX');
            expect(failure('')).toBe('DICE.ERROR.EMPTY');
        });

        it('agrees with the published limits', () => {
            expect(DICE_LIMITS.diceTotal).toBe(100);
            expect(DICE_LIMITS.expressionLength).toBe(128);
        });
    });
});

describe('keptDice', () => {
    const pool = (count: number, keep: {mode: 'kh' | 'kl' | 'dh' | 'dl'; n: number} | null) => ({
        notation: '',
        sign: 1 as const,
        constant: null,
        count,
        sides: 6,
        explode: false,
        keep,
        advantage: null,
    });

    it('keeps everything without a mode', () => {
        expect(keptDice([1, 2, 3], pool(3, null))).toEqual([1, 2, 3]);
    });

    it('keeps the highest, in the order they were rolled', () => {
        expect(keptDice([1, 6, 3, 5], pool(4, {mode: 'kh', n: 3}))).toEqual([6, 3, 5]);
    });

    it('drops the lowest', () => {
        expect(keptDice([1, 6, 3, 5], pool(4, {mode: 'dl', n: 1}))).toEqual([6, 3, 5]);
    });

    it('keeps only one copy of a repeated face rather than both', () => {
        expect(keptDice([4, 4, 1], pool(3, {mode: 'kh', n: 1}))).toEqual([4]);
    });
});

describe('buildBreakdown', () => {
    it('marks a die that did not count with a leading tilde', () => {
        const line = buildBreakdown([
            {notation: '4d6kh3', sign: 1, constant: null, dice: [6, 5, 3, 1], kept: [6, 5, 3], subtotal: 14},
            {notation: '2', sign: 1, constant: 2, dice: [], kept: [], subtotal: 2},
        ]);
        expect(line).toBe('4d6kh3 (6, 5, 3, ~1) + 2');
    });

    it('marks only one of a repeated face when only one was kept', () => {
        const line = buildBreakdown([
            {notation: '2d6kh1', sign: 1, constant: null, dice: [4, 4], kept: [4], subtotal: 4},
        ]);
        expect(line).toBe('2d6kh1 (4, ~4)');
    });
});

describe('rollParsed', () => {
    it('stays inside the faces of the dice it was asked for', () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const {total, terms} = rollParsed(parse('3d6+2'));
            expect(total).toBeGreaterThanOrEqual(5);
            expect(total).toBeLessThanOrEqual(20);
            expect(terms[0].dice.every(face => face >= 1 && face <= 6)).toBe(true);
        }
    });

    it('counts only the kept dice towards the total', () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const {total, terms} = rollParsed(parse('4d6kh3'));
            expect(terms[0].kept).toHaveLength(3);
            expect(total).toBe(terms[0].kept.reduce((sum, face) => sum + face, 0));
        }
    });

    it('subtracts a negative term instead of adding it', () => {
        const {total, terms} = rollParsed(parse('10-1d1000'));
        expect(total).toBe(10 - terms[1].subtotal);
    });
});
