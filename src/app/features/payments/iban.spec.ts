import {describe, expect, it} from 'vitest';
import {checkIban, formatIban, isSwissQrEligibleIban, isValidIban, normalizeIban} from './iban';

/**
 * Known-good IBANs, taken from the published examples of their own issuers and standards bodies.
 * Every one of these has a correct mod-97 checksum by construction.
 */
const VALID = {
    swiss: 'CH4431999123000889012',
    swissAlt: 'CH9300762011623852957',
    liechtenstein: 'LI5908800000021234567',
    german: 'DE75512108001245126199',
    british: 'GB33BUKB20201555555555',
    maltese: 'MT84MALT011000012345MTLCAST001S',
    /**
     * 34 characters, the longest registered length. This is the case where the obvious one-line
     * mod-97 - parse the whole rearranged string as a `Number` - silently returns the wrong
     * remainder, because 34 characters expand past `Number.MAX_SAFE_INTEGER`.
     */
    longest: 'LC42ABCD01234567890123456789012345',
} as const;

describe('normalizeIban', () => {
    it('strips the grouping a bank statement prints and upper-cases the rest', () => {
        expect(normalizeIban('ch44 3199 9123 0008 8901 2')).toBe(VALID.swiss);
    });

    it('strips the narrow and non-breaking spaces a copy-paste brings with it', () => {
        // A statement copied out of e-banking arrives grouped with U+00A0 or U+202F, not with
        // ordinary spaces, and a naive replace(/ /g) leaves those behind.
        const pasted = 'CH44' + '\u00a03199' + '\u202f9123' + '\u00a00008' + ' 8901' + ' 2';
        expect(normalizeIban(pasted)).toBe(VALID.swiss);
    });

    it('is idempotent, so normalising on every blur cannot drift the value', () => {
        expect(normalizeIban(normalizeIban('ch44 3199 9123 0008 8901 2'))).toBe(VALID.swiss);
    });
});

describe('formatIban', () => {
    it('groups in fours, which is how an IBAN is read aloud', () => {
        expect(formatIban(VALID.swiss)).toBe('CH44 3199 9123 0008 8901 2');
    });

    it('round-trips back through normalize unchanged', () => {
        expect(normalizeIban(formatIban(VALID.swiss))).toBe(VALID.swiss);
    });
});

describe('checkIban - accepting the real ones', () => {
    for (const [name, iban] of Object.entries(VALID)) {
        it(`accepts the ${name} example`, () => {
            expect(checkIban(iban)).toMatchObject({valid: true, problem: null});
        });
    }

    it('accepts a 34-character IBAN, where a single-integer mod-97 would lose precision', () => {
        expect(VALID.longest).toHaveLength(34);
        expect(isValidIban(VALID.longest)).toBe(true);
    });

    it('accepts one typed in the grouped form', () => {
        expect(isValidIban('CH44 3199 9123 0008 8901 2')).toBe(true);
    });
});

describe('checkIban - the mistakes that actually happen', () => {
    it('rejects a single mistyped digit, which is the whole point of the checksum', () => {
        // One digit changed from the valid Swiss example. Mod-97 catches every single-character
        // error; without this check the money reaches whoever owns the account it became.
        expect(checkIban('CH4431999123000889013')).toMatchObject({
            valid: false,
            problem: 'checksum',
        });
    });

    it('rejects two adjacent digits transposed', () => {
        expect(checkIban('CH4431999123000889021')).toMatchObject({problem: 'checksum'});
    });

    it('rejects an O typed for a zero as a charset problem, not as a bad checksum', () => {
        // The message matters: telling somebody their checksum is wrong sends them to re-check the
        // wrong end of the number when what they did was type a letter for a digit.
        expect(checkIban('CH44319991230OO889012')).toMatchObject({problem: 'checksum'});
        expect(checkIban('CH4a31999123000889012')).toMatchObject({problem: 'charset'});
    });

    it('rejects a Swiss IBAN one character short before the checksum is even tried', () => {
        expect(checkIban('CH443199912300088901')).toMatchObject({problem: 'country-length'});
    });

    it('rejects a Swiss IBAN one character long', () => {
        expect(checkIban('CH44319991230008890123')).toMatchObject({problem: 'country-length'});
    });

    it('reports an empty value as empty rather than as malformed', () => {
        expect(checkIban('')).toMatchObject({valid: false, problem: 'empty'});
        expect(checkIban('   ')).toMatchObject({valid: false, problem: 'empty'});
    });

    it('rejects a value with no country prefix', () => {
        expect(checkIban('4431999123000889012')).toMatchObject({problem: 'charset'});
    });

    it('rejects something far too short to be an IBAN at all', () => {
        // Long enough to be shaped like an IBAN, far too short to be one.
        expect(checkIban('CH4431')).toMatchObject({problem: 'length'});
        // Nothing after the check digits at all is a charset problem, not a length one.
        expect(checkIban('CH44')).toMatchObject({problem: 'charset'});
    });

    it('checks an unlisted country by checksum alone rather than refusing it', () => {
        // Kuwait is not in the length table. Refusing an IBAN the table has simply not heard of is
        // a worse failure than accepting one whose length we cannot confirm.
        expect(checkIban('KW81CBKU0000000000001234560101')).toMatchObject({valid: true});
    });

    it('still reports the normalized value on a rejection, so the field can echo it back', () => {
        expect(checkIban('ch44 3199 9123 0008 8901 3').normalized).toBe('CH4431999123000889013');
    });
});

describe('isSwissQrEligibleIban', () => {
    it('accepts CH and LI, which are the only two the Swiss QR-bill carries', () => {
        expect(isSwissQrEligibleIban(VALID.swiss)).toBe(true);
        expect(isSwissQrEligibleIban(VALID.liechtenstein)).toBe(true);
    });

    it('rejects a perfectly valid German IBAN, because the scheme is Swiss-only', () => {
        expect(isValidIban(VALID.german)).toBe(true);
        expect(isSwissQrEligibleIban(VALID.german)).toBe(false);
    });

    it('rejects an invalid Swiss IBAN rather than trusting the country prefix', () => {
        expect(isSwissQrEligibleIban('CH4431999123000889013')).toBe(false);
    });
});
