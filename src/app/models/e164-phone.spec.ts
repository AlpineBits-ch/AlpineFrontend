import {describe, expect, it} from 'vitest';
import {checkE164, E164_MAX_DIGITS, E164_PROBLEMS, e164ProblemKey, normalizeE164} from './e164-phone';

/** The client half of a rule the server also enforces; the cases come from the server's own tests. */
describe('checkE164', () => {
    it('accepts a plain international number', () => {
        expect(normalizeE164('+41791234567')).toBe('+41791234567');
    });

    it('strips the separators people paste off a contact card, including a non-breaking space', () => {
        expect(normalizeE164('+41 79 123 45 67')).toBe('+41791234567');
        expect(normalizeE164('+41-79-123-45-67')).toBe('+41791234567');
        expect(normalizeE164('+1 (555) 010.4477')).toBe('+15550104477');
        expect(normalizeE164(`+41${String.fromCharCode(160)}79${String.fromCharCode(160)}1234567`))
            .toBe('+41791234567');
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeE164('  +41791234567  ')).toBe('+41791234567');
    });

    it('refuses a leading 00 rather than rewriting it to +', () => {
        // The single most important case in this file. A rewrite here is silent and unverifiable.
        expect(checkE164('0041791234567')).toEqual({e164: null, problem: 'no-plus'});
    });

    it('refuses a national number with no country code', () => {
        expect(checkE164('079 123 45 67')).toEqual({e164: null, problem: 'no-plus'});
    });

    it('refuses a trunk prefix that got a + stuck on the front', () => {
        // No country code begins with zero, so "+0..." is somebody who fixed the wrong half of it.
        expect(checkE164('+0041791234567')).toEqual({e164: null, problem: 'trunk-prefix'});
        expect(checkE164('+079123456')).toEqual({e164: null, problem: 'trunk-prefix'});
    });

    it('refuses anything that is neither a digit nor a separator', () => {
        expect(checkE164('+4179123456a')).toEqual({e164: null, problem: 'not-a-number'});
        expect(checkE164('+41 79 EXT 1234')).toEqual({e164: null, problem: 'not-a-number'});
    });

    it('refuses a number too short to be one', () => {
        expect(checkE164('+').problem).toBe('too-short');
        expect(checkE164('+1').problem).toBe('too-short');
        expect(checkE164('+12345').problem).toBe('too-short');
    });

    it('refuses more digits than E.164 carries', () => {
        expect(checkE164(`+${'1'.repeat(E164_MAX_DIGITS)}`).problem).toBeNull();
        expect(checkE164(`+${'1'.repeat(E164_MAX_DIGITS + 1)}`).problem).toBe('too-long');
    });

    it('reports an untouched box as empty rather than as wrong', () => {
        expect(checkE164('').problem).toBe('empty');
        expect(checkE164('   ').problem).toBe('empty');
        expect(checkE164(null).problem).toBe('empty');
        expect(checkE164(undefined).problem).toBe('empty');
    });

    it('is idempotent, because a stored number is re-checked every time the form opens', () => {
        const once = normalizeE164('+41 79 123 45 67')!;
        expect(normalizeE164(once)).toBe(once);
    });

    it('names a translation key per problem', () => {
        expect(e164ProblemKey('no-plus')).toBe('ACCOUNT.PHONE.PROBLEM.NO_PLUS');
        expect(e164ProblemKey('trunk-prefix')).toBe('ACCOUNT.PHONE.PROBLEM.TRUNK_PREFIX');
        expect(new Set(E164_PROBLEMS.map(e164ProblemKey)).size).toBe(E164_PROBLEMS.length);
    });
});
