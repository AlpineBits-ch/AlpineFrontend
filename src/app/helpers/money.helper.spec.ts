import {describe, expect, it} from 'vitest';
import {formatMinor, minorToInputString, minorUnitDigits, parseMinor} from './money.helper';

/**
 * The money boundary, which is the only place in the ledger where a decimal exists at all.
 *
 * <p>Two properties matter more than any individual case here: nothing this file produces is ever a
 * fractional `number`, and anything {@link minorToInputString} writes comes back through
 * {@link parseMinor} as the integer it started as. Everything else is a spelling of those two.</p>
 */
describe('minorUnitDigits', () => {
    it('is two for the ordinary currencies', () => {
        expect(minorUnitDigits('CHF')).toBe(2);
        expect(minorUnitDigits('EUR')).toBe(2);
        expect(minorUnitDigits('usd')).toBe(2);
    });

    it('reads the ISO exponent, not a guess: JPY has no minor unit and KWD has three digits', () => {
        expect(minorUnitDigits('JPY')).toBe(0);
        expect(minorUnitDigits('KWD')).toBe(3);
    });

    it('falls back to two digits for a code Intl will not take, rather than throwing', () => {
        expect(minorUnitDigits('not-a-currency')).toBe(2);
        expect(minorUnitDigits('')).toBe(2);
    });
});

describe('parseMinor', () => {
    it('turns 12.34 into 1234 - never 12.34', () => {
        expect(parseMinor('12.34', 'CHF', 'en-US')).toBe(1234);
    });

    it('pads a short fraction rather than misreading it', () => {
        expect(parseMinor('12.3', 'CHF', 'en-US')).toBe(1230);
        expect(parseMinor('12.03', 'CHF', 'en-US')).toBe(1203);
        expect(parseMinor('0.05', 'CHF', 'en-US')).toBe(5);
    });

    it('treats a whole number as whole units', () => {
        expect(parseMinor('12', 'CHF', 'en-US')).toBe(1200);
        expect(parseMinor('0', 'CHF', 'en-US')).toBe(0);
    });

    it('is exact where float arithmetic is not', () => {
        // 0.1 + 0.2 territory: 1.15 * 100 is 114.99999999999999 in binary floating point.
        expect(parseMinor('1.15', 'CHF', 'en-US')).toBe(115);
        expect(parseMinor('8.87', 'CHF', 'en-US')).toBe(887);
        expect(parseMinor('1234567.89', 'CHF', 'en-US')).toBe(123456789);
    });

    it('accepts a comma as a decimal mark', () => {
        expect(parseMinor('12,34', 'CHF', 'en-US')).toBe(1234);
    });

    it('drops grouping marks that can only be grouping', () => {
        expect(parseMinor("1'234.50", 'CHF', 'de-CH')).toBe(123450);
        expect(parseMinor('1 234,50', 'CHF', 'fr-FR')).toBe(123450);
        expect(parseMinor('  42.00  ', 'CHF', 'en-US')).toBe(4200);
    });

    it('resolves a mixed pair by taking the last mark as the decimal one', () => {
        expect(parseMinor('1,234.56', 'CHF', 'en-US')).toBe(123456);
        expect(parseMinor('1.234,56', 'CHF', 'de-DE')).toBe(123456);
    });

    it('reads a repeated mark as grouping, because there is no other reading', () => {
        expect(parseMinor('1.234.567', 'CHF', 'de-DE')).toBe(123456700);
    });

    it('lets the locale break the "one mark, three digits" tie', () => {
        // en-US groups with a comma, so "1,234" is a thousand and change of nothing.
        expect(parseMinor('1,234', 'CHF', 'en-US')).toBe(123400);
        // de-DE groups with a dot, so the same shape with the other character is a thousand there.
        expect(parseMinor('1.234', 'CHF', 'de-DE')).toBe(123400);
    });

    it('rejects rather than guesses when the tie cannot be broken', () => {
        // de-DE's comma is its decimal mark, so "1,234" is three decimals in a two-digit
        // currency - which is an error, not a thousand. Guessing here is a 1000x error in rent.
        expect(parseMinor('1,234', 'CHF', 'de-DE')).toBeNull();
    });

    it('rejects precision the currency cannot hold', () => {
        expect(parseMinor('0.005', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('12.3456', 'CHF', 'en-US')).toBeNull();
        // Yen has no minor unit at all.
        expect(parseMinor('12.5', 'JPY', 'en-US')).toBeNull();
    });

    it('allows trailing zeros past the currency precision, which carry no value', () => {
        expect(parseMinor('12.500', 'CHF', 'en-US')).toBe(1250);
        expect(parseMinor('12.000', 'JPY', 'en-US')).toBe(12);
    });

    it('honours the currency exponent', () => {
        expect(parseMinor('1234', 'JPY', 'en-US')).toBe(1234);
        expect(parseMinor('1.5', 'KWD', 'en-US')).toBe(1500);
        expect(parseMinor('1.234', 'KWD', 'en-US')).toBe(1234);
    });

    it('keeps a negative sign', () => {
        expect(parseMinor('-12.34', 'CHF', 'en-US')).toBe(-1234);
        expect(parseMinor('+12.34', 'CHF', 'en-US')).toBe(1234);
    });

    it('rejects anything that is not a number', () => {
        expect(parseMinor('', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('   ', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('-', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('abc', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('12.34 CHF', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('12.', 'CHF', 'en-US')).toBeNull();
        expect(parseMinor('1e3', 'CHF', 'en-US')).toBeNull();
    });

    it('rejects an amount too large to hold exactly, rather than rounding it', () => {
        expect(parseMinor('99999999999999999999', 'CHF', 'en-US')).toBeNull();
    });

    it('always returns a whole number', () => {
        for (const input of ['0.01', '1.99', '1234.56', '7.05', '9.95', '0.1']) {
            const minor = parseMinor(input, 'CHF', 'en-US');
            expect(Number.isSafeInteger(minor)).toBe(true);
        }
    });
});

/**
 * ICU separates a currency code from its digits with a non-breaking space, and which width it
 * picks is a CLDR detail that moves between engine versions. Every assertion below is about the
 * digits, so the spaces are flattened rather than pinned.
 */
const flat = (value: string) => value.replace(/[\u00a0\u202f\u2009]/g, ' ');

describe('formatMinor', () => {
    it('moves the decimal point without dividing', () => {
        expect(flat(formatMinor(1234, 'CHF', 'en-US'))).toBe('CHF 12.34');
        expect(flat(formatMinor(5, 'CHF', 'en-US'))).toBe('CHF 0.05');
        expect(flat(formatMinor(0, 'CHF', 'en-US'))).toBe('CHF 0.00');
    });

    it('groups the whole part', () => {
        expect(flat(formatMinor(123456789, 'CHF', 'en-US'))).toBe('CHF 1,234,567.89');
    });

    it('honours the currency exponent', () => {
        expect(flat(formatMinor(1234, 'JPY', 'en-US'))).toBe('¥1,234');
        expect(flat(formatMinor(1234, 'KWD', 'en-US'))).toBe('KWD 1.234');
    });

    it('keeps the sign', () => {
        expect(flat(formatMinor(-1234, 'CHF', 'en-US'))).toBe('-CHF 12.34');
    });

    it('renders an amount larger than Number.MAX_SAFE_INTEGER would survive as digits', () => {
        // The point is that the digits are sliced out of a string, so nothing is lost on the way.
        expect(flat(formatMinor(900719925474099, 'CHF', 'en-US'))).toBe('CHF 9,007,199,254,740.99');
    });

    it('still renders something for a code Intl rejects', () => {
        expect(formatMinor(1234, 'XYZZY', 'en-US')).toContain('12.34');
    });
});

describe('minorToInputString', () => {
    it('round-trips exactly through parseMinor', () => {
        for (const minor of [0, 1, 5, 99, 100, 1234, -1234, 123456789]) {
            const text = minorToInputString(minor, 'CHF');
            expect(parseMinor(text, 'CHF', 'en-US')).toBe(minor);
        }
    });

    it('round-trips in a currency with no minor unit', () => {
        expect(minorToInputString(1234, 'JPY')).toBe('1234');
        expect(parseMinor('1234', 'JPY', 'en-US')).toBe(1234);
    });

    it('is unformatted on purpose, so an untouched edit form saves what it opened with', () => {
        expect(minorToInputString(123456789, 'CHF')).toBe('1234567.89');
    });
});
