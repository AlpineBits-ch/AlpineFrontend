import {describe, expect, it} from 'vitest';
import {
    buildSwissQrBillPayload,
    SPC_MAX_CHARACTERS,
    SPC_TRAILER_LINE,
    SwissQrBillError,
    SwissQrBillInput,
    swissQrUnavailableReason,
} from './swiss-qr-bill';

/**
 * The worked example from the research brief, with the creditor block filled in exactly as printed
 * there: `CH4431999123000889012`, Anna Muster, Bahnhofstrasse 12, 8001 Zuerich, CH, 42.50 CHF,
 * message "Groceries July - shared flat".
 */
function input(overrides: Partial<SwissQrBillInput> = {}): SwissQrBillInput {
    return {
        creditor: {
            iban: 'CH4431999123000889012',
            name: 'Anna Muster',
            street: 'Bahnhofstrasse',
            buildingNumber: '12',
            postCode: '8001',
            town: 'Zuerich',
            country: 'CH',
        },
        amountMinor: 4250,
        currency: 'CHF',
        message: 'Groceries July - shared flat',
        ...overrides,
    };
}

function lines(payload: string): string[] {
    return payload.split('\n');
}

describe('buildSwissQrBillPayload - the structure the specification fixes', () => {
    it('emits exactly 31 lines, ending at the EPD trailer', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out).toHaveLength(SPC_TRAILER_LINE);
        expect(out[SPC_TRAILER_LINE - 1]).toBe('EPD');
    });

    it('separates with LF and adds no trailing newline', () => {
        const payload = buildSwissQrBillPayload(input());
        expect(payload).not.toContain('\r');
        expect(payload.endsWith('EPD')).toBe(true);
    });

    it('opens with SPC, version 0200 and coding type 1', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out[0]).toBe('SPC');
        // 0200 encodes the 2.x generation, not the point release. `0230` would be wrong.
        expect(out[1]).toBe('0200');
        expect(out[2]).toBe('1');
    });

    it('puts the creditor block on lines 4 to 11 with the structured address type', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out[3]).toBe('CH4431999123000889012');   // 4  IBAN
        expect(out[4]).toBe('S');                       // 5  address type, structured since Nov 2025
        expect(out[5]).toBe('Anna Muster');             // 6  name
        expect(out[6]).toBe('Bahnhofstrasse');          // 7  street
        expect(out[7]).toBe('12');                      // 8  building number
        expect(out[8]).toBe('8001');                    // 9  post code
        expect(out[9]).toBe('Zuerich');                 // 10 town
        expect(out[10]).toBe('CH');                     // 11 country
    });

    /**
     * The regression this whole file exists to hold. The brief's copy-pasteable snippet has six
     * blank lines here rather than seven, which moves the amount to line 18 and the currency to 19.
     * A bank app reads "42.50" as the ultimate creditor's country and finds no amount at all.
     */
    it('leaves seven blank lines for the ultimate creditor, not six', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out.slice(11, 18)).toEqual(['', '', '', '', '', '', '']);
    });

    it('puts the amount on line 19 and the currency on line 20', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out[18]).toBe('42.50');
        expect(out[19]).toBe('CHF');
    });

    it('leaves seven blank lines for the ultimate debtor', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out.slice(20, 27)).toEqual(['', '', '', '', '', '', '']);
    });

    it('uses reference type NON with an empty reference line', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        // A private person holds an ordinary IBAN, which pairs with NON. QRR belongs to a QR-IBAN.
        expect(out[27]).toBe('NON');
        expect(out[28]).toBe('');
    });

    it('puts the unstructured message on line 30', () => {
        const out = lines(buildSwissQrBillPayload(input()));
        expect(out[29]).toBe('Groceries July - shared flat');
    });

    it('reproduces the brief worked example in full', () => {
        expect(buildSwissQrBillPayload(input())).toBe([
            'SPC', '0200', '1',
            'CH4431999123000889012',
            'S', 'Anna Muster', 'Bahnhofstrasse', '12', '8001', 'Zuerich', 'CH',
            '', '', '', '', '', '', '',
            '42.50', 'CHF',
            '', '', '', '', '', '', '',
            'NON', '',
            'Groceries July - shared flat',
            'EPD',
        ].join('\n'));
    });
});

describe('buildSwissQrBillPayload - the amount', () => {
    it('renders whole minor units as a dot decimal with two places', () => {
        expect(lines(buildSwissQrBillPayload(input({amountMinor: 4250})))[18]).toBe('42.50');
        expect(lines(buildSwissQrBillPayload(input({amountMinor: 5})))[18]).toBe('0.05');
        expect(lines(buildSwissQrBillPayload(input({amountMinor: 100000})))[18]).toBe('1000.00');
    });

    it('emits no thousands separator, which the field forbids', () => {
        const amount = lines(buildSwissQrBillPayload(input({amountMinor: 123456789})))[18];
        expect(amount).toBe('1234567.89');
        expect(amount).not.toMatch(/[',\s]/);
    });

    it('leaves the amount empty for an open bill the payer fills in', () => {
        const out = lines(buildSwissQrBillPayload(input({amountMinor: null})));
        expect(out[18]).toBe('');
        // The currency stays: it is mandatory whether or not there is an amount.
        expect(out[19]).toBe('CHF');
    });

    it('refuses zero, which is not a payable amount and is not the same as an open one', () => {
        expect(() => buildSwissQrBillPayload(input({amountMinor: 0}))).toThrow(SwissQrBillError);
    });

    it('refuses a negative amount', () => {
        expect(() => buildSwissQrBillPayload(input({amountMinor: -100}))).toThrow(SwissQrBillError);
    });

    it('refuses a fractional amount rather than rounding somebody money', () => {
        expect(() => buildSwissQrBillPayload(input({amountMinor: 42.5}))).toThrow(/whole minor units/);
    });

    it('refuses an amount past the field maximum', () => {
        expect(() => buildSwissQrBillPayload(input({amountMinor: 100_000_000_000})))
            .toThrow(SwissQrBillError);
    });
});

describe('buildSwissQrBillPayload - what it refuses', () => {
    it('refuses a German IBAN, valid though it is', () => {
        // The QR-bill was developed for payments inside Switzerland and Liechtenstein only. A
        // perfectly good DE IBAN in this field produces a code no Swiss bank app will act on.
        const err = grab(() => buildSwissQrBillPayload(input({
            creditor: {...input().creditor, iban: 'DE75512108001245126199'},
        })));
        expect(err).toBeInstanceOf(SwissQrBillError);
        expect((err as SwissQrBillError).field).toBe('iban');
        expect(err?.message).toContain('DE');
    });

    it('refuses an IBAN that fails mod-97 even when it starts CH', () => {
        expect(() => buildSwissQrBillPayload(input({
            creditor: {...input().creditor, iban: 'CH4431999123000889013'},
        }))).toThrow(/not a valid IBAN/);
    });

    it('refuses a currency other than CHF or EUR', () => {
        expect(() => buildSwissQrBillPayload(
            input({currency: 'GBP' as unknown as 'CHF'})),
        ).toThrow(/CHF or EUR/);
    });

    it('accepts EUR, which is the one other currency the scheme carries', () => {
        expect(lines(buildSwissQrBillPayload(input({currency: 'EUR'})))[19]).toBe('EUR');
    });

    it('refuses a missing creditor name, post code or town', () => {
        for (const field of ['name', 'postCode', 'town'] as const) {
            expect(() => buildSwissQrBillPayload(input({
                creditor: {...input().creditor, [field]: '   '},
            }))).toThrow(SwissQrBillError);
        }
    });

    it('allows an empty street and building number', () => {
        const out = lines(buildSwissQrBillPayload(input({
            creditor: {...input().creditor, street: undefined, buildingNumber: undefined},
        })));
        expect(out[6]).toBe('');
        expect(out[7]).toBe('');
        // Everything after them must not have shifted.
        expect(out[18]).toBe('42.50');
    });

    it('refuses a creditor country that is not a two-letter code', () => {
        expect(() => buildSwissQrBillPayload(input({
            creditor: {...input().creditor, country: 'Switzerland'},
        }))).toThrow(/two-letter/);
    });

    it('refuses an over-long name rather than truncating it', () => {
        expect(() => buildSwissQrBillPayload(input({
            creditor: {...input().creditor, name: 'A'.repeat(71)},
        }))).toThrow(/over the 70 limit/);
    });

    it('refuses an over-long message', () => {
        expect(() => buildSwissQrBillPayload(input({message: 'x'.repeat(141)})))
            .toThrow(/over the 140 limit/);
    });

    /**
     * The security case, not a tidiness one. The payload is line-separated, so a line feed inside a
     * name lets whoever typed that name choose what the payer's bank shows in the amount and the
     * IBAN fields - and the name arrives here out of somebody else's sealed blob.
     */
    it('refuses a line feed inside a field, which would rewrite every line after it', () => {
        expect(() => buildSwissQrBillPayload(input({
            creditor: {...input().creditor, name: 'Anna Muster\nCH9300762011623852957'},
        }))).toThrow(/line break or control character/);
    });

    it('refuses a carriage return and a Unicode line separator too', () => {
        expect(() => buildSwissQrBillPayload(input({message: 'a\rb'}))).toThrow(SwissQrBillError);
        expect(() => buildSwissQrBillPayload(input({message: 'a' + '\u2028' + 'b'}))).toThrow(SwissQrBillError);
    });

    it('keeps the payload inside the character cap', () => {
        expect(buildSwissQrBillPayload(input()).length).toBeLessThanOrEqual(SPC_MAX_CHARACTERS);
    });
});

describe('buildSwissQrBillPayload - tolerances on the way in', () => {
    it('accepts a grouped IBAN and stores the compact form', () => {
        expect(lines(buildSwissQrBillPayload(input({
            creditor: {...input().creditor, iban: 'CH44 3199 9123 0008 8901 2'},
        })))[3]).toBe('CH4431999123000889012');
    });

    it('upper-cases the country and the currency', () => {
        const out = lines(buildSwissQrBillPayload(input({
            creditor: {...input().creditor, country: 'ch'},
            currency: 'chf' as 'CHF',
        })));
        expect(out[10]).toBe('CH');
        expect(out[19]).toBe('CHF');
    });

    it('keeps umlauts, which v2.3 explicitly permits', () => {
        expect(lines(buildSwissQrBillPayload(input({
            creditor: {...input().creditor, town: 'Zürich'},
        })))[9]).toBe('Zürich');
    });
});

describe('swissQrUnavailableReason', () => {
    it('says ok for a CH IBAN in CHF', () => {
        expect(swissQrUnavailableReason('CH4431999123000889012', 'CHF')).toBe('ok');
    });

    it('says ok for an LI IBAN in EUR', () => {
        expect(swissQrUnavailableReason('LI5908800000021234567', 'EUR')).toBe('ok');
    });

    it('distinguishes a foreign IBAN from a mistyped one, because the fix differs', () => {
        // "Your flatmate banks in Germany" is a permanent fact about this pairing; "you typed it
        // wrong" is something to go and correct. The same message for both would be useless.
        expect(swissQrUnavailableReason('DE75512108001245126199', 'CHF')).toBe('iban-not-swiss');
        expect(swissQrUnavailableReason('CH4431999123000889013', 'CHF')).toBe('iban-invalid');
    });

    it('names the currency when the house keeps its ledger in something else', () => {
        expect(swissQrUnavailableReason('CH4431999123000889012', 'GBP')).toBe('currency');
    });
});

function grab(fn: () => unknown): Error | null {
    try {
        fn();
        return null;
    } catch (err) {
        return err as Error;
    }
}
