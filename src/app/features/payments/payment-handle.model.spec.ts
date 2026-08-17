import {describe, expect, it} from 'vitest';
import {
    capabilitiesOf,
    checkHandleValue,
    displayHandleValue,
    HANDLE_LIMITS,
    normalizeHandleValue,
    parsePayload,
    PaymentHandleKind,
    serializePayload,
} from './payment-handle.model';

describe('normalizeHandleValue', () => {
    it('compacts and upper-cases an IBAN', () => {
        expect(normalizeHandleValue(PaymentHandleKind.Iban, ' ch44 3199 9123 0008 8901 2 ')).toBe(
            'CH4431999123000889012',
        );
    });

    it('strips the @ every one of these providers displays a handle with', () => {
        expect(normalizeHandleValue(PaymentHandleKind.Revolut, '@annamuster')).toBe('annamuster');
        expect(normalizeHandleValue(PaymentHandleKind.Venmo, '@anna-muster')).toBe('anna-muster');
    });

    it('reduces a pasted profile link to the handle', () => {
        // What people copy is the URL, not the handle. Refusing it teaches them to hand-edit the
        // field, which is where the typos come from.
        expect(normalizeHandleValue(PaymentHandleKind.PayPal, 'https://paypal.me/annamuster')).toBe(
            'annamuster',
        );
        expect(normalizeHandleValue(PaymentHandleKind.Revolut, 'revolut.me/annamuster')).toBe('annamuster');
        expect(normalizeHandleValue(PaymentHandleKind.Wise, 'https://wise.com/pay/me/@anna1234')).toBe(
            'anna1234',
        );
    });

    it('drops a query string rather than storing it as part of the handle', () => {
        expect(normalizeHandleValue(PaymentHandleKind.PayPal, 'paypal.me/anna?locale=de')).toBe('anna');
    });

    it('is idempotent for every kind, so normalising on blur cannot drift the value', () => {
        for (const kind of Object.values(PaymentHandleKind)) {
            const once = normalizeHandleValue(kind, '  @Anna.Muster  ');
            expect(normalizeHandleValue(kind, once)).toBe(once);
        }
    });

    it('leaves free text alone apart from trimming it', () => {
        expect(normalizeHandleValue(PaymentHandleKind.Other, '  Ask me in person  ')).toBe(
            'Ask me in person',
        );
    });
});

describe('checkHandleValue', () => {
    it('accepts a valid IBAN and reports the compact form', () => {
        expect(checkHandleValue(PaymentHandleKind.Iban, 'CH44 3199 9123 0008 8901 2')).toMatchObject({
            valid: true,
            normalized: 'CH4431999123000889012',
        });
    });

    it('surfaces the IBAN problem specifically rather than a generic refusal', () => {
        expect(checkHandleValue(PaymentHandleKind.Iban, 'CH4431999123000889013').problem).toBe(
            'iban-checksum',
        );
        expect(checkHandleValue(PaymentHandleKind.Iban, 'CH443199912300088901').problem).toBe(
            'iban-country-length',
        );
    });

    it('accepts realistic provider handles', () => {
        expect(checkHandleValue(PaymentHandleKind.PayPal, 'annamuster').valid).toBe(true);
        expect(checkHandleValue(PaymentHandleKind.Revolut, 'annam').valid).toBe(true);
        expect(checkHandleValue(PaymentHandleKind.Venmo, 'anna-muster').valid).toBe(true);
        expect(checkHandleValue(PaymentHandleKind.Wise, 'anna.muster_1').valid).toBe(true);
    });

    it('refuses a PayPal handle with characters PayPal does not allow', () => {
        expect(checkHandleValue(PaymentHandleKind.PayPal, 'anna muster').problem).toBe('charset');
        expect(checkHandleValue(PaymentHandleKind.PayPal, 'anna-muster').problem).toBe('charset');
    });

    it('refuses handles outside each provider length', () => {
        expect(checkHandleValue(PaymentHandleKind.PayPal, 'a'.repeat(21)).problem).toBe('too-long');
        expect(checkHandleValue(PaymentHandleKind.Venmo, 'abc').problem).toBe('too-short');
    });

    it('refuses an empty value as empty', () => {
        expect(checkHandleValue(PaymentHandleKind.PayPal, '   ').problem).toBe('empty');
    });

    it('caps free text but otherwise accepts anything', () => {
        expect(checkHandleValue(PaymentHandleKind.Other, 'Cash, in the kitchen jar').valid).toBe(true);
        expect(checkHandleValue(PaymentHandleKind.Other, 'x'.repeat(141)).problem).toBe('too-long');
    });
});

describe('capabilitiesOf', () => {
    it('says PayPal is the only kind that carries both an amount and a currency', () => {
        const paypal = capabilitiesOf(PaymentHandleKind.PayPal);
        expect(paypal).toMatchObject({
            linkable: true,
            canPrefillAmount: true,
            canPrefillCurrency: true,
        });

        for (const kind of Object.values(PaymentHandleKind)) {
            if (kind === PaymentHandleKind.PayPal) continue;
            expect(capabilitiesOf(kind).canPrefillCurrency).toBe(false);
        }
    });

    it('says Revolut is linkable but cannot carry an amount', () => {
        // An amount-bearing Revolut link is minted by the recipient in-app, per request. There is
        // no query parameter, and a UI that showed an amount on this link would be lying.
        expect(capabilitiesOf(PaymentHandleKind.Revolut)).toMatchObject({
            linkable: true,
            canPrefillAmount: false,
        });
    });

    it('says Wise and Venmo are not linkable at all', () => {
        // Wise publishes an open link for business accounts only and never publishes the Wisetag
        // URL format. Venmo's scheme is reverse-engineered and has been reported broken once.
        expect(capabilitiesOf(PaymentHandleKind.Wise).linkable).toBe(false);
        expect(capabilitiesOf(PaymentHandleKind.Venmo).linkable).toBe(false);
    });

    it('says no kind we ship can lock an amount', () => {
        // Swish is the only provider in the research set that can, and we do not ship Sweden. So
        // the payer can edit the figure in every flow, and the ledger must not assume otherwise.
        for (const kind of Object.values(PaymentHandleKind)) {
            expect(capabilitiesOf(kind).canLockAmount).toBe(false);
        }
    });
});

describe('displayHandleValue', () => {
    it('groups an IBAN in fours and leaves everything else verbatim', () => {
        expect(
            displayHandleValue({
                kind: PaymentHandleKind.Iban,
                value: 'CH4431999123000889012',
            }),
        ).toBe('CH44 3199 9123 0008 8901 2');

        expect(
            displayHandleValue({
                kind: PaymentHandleKind.PayPal,
                value: 'annamuster',
            }),
        ).toBe('annamuster');
    });
});

describe('serializePayload and parsePayload', () => {
    it('round-trips a payload unchanged', () => {
        const payload = {
            version: 1 as const,
            handles: [
                {kind: PaymentHandleKind.Iban, value: 'CH4431999123000889012', label: 'Salary'},
                {kind: PaymentHandleKind.PayPal, value: 'annamuster'},
            ],
            creditor: {
                name: 'Anna Muster',
                street: 'Bahnhofstrasse',
                buildingNumber: '12',
                postCode: '8001',
                town: 'Zuerich',
                country: 'CH',
            },
        };

        expect(parsePayload(serializePayload(payload))).toEqual(payload);
    });

    it('omits an absent label rather than writing null', () => {
        const json = serializePayload({
            version: 1,
            handles: [{kind: PaymentHandleKind.PayPal, value: 'anna'}],
        });
        expect(JSON.parse(json).handles[0]).not.toHaveProperty('label');
    });

    it('drops a kind this build has never heard of instead of failing the whole payload', () => {
        // A newer Alpine may have sealed a kind we do not know. Failing here would tell the user
        // their flatmate has shared nothing, which is worse than showing one row fewer.
        const parsed = parsePayload(
            JSON.stringify({
                version: 1,
                handles: [
                    {kind: 'Swish', value: '46701234567'},
                    {kind: 'PayPal', value: 'anna'},
                ],
            }),
        );

        expect(parsed.handles.map(h => h.kind)).toEqual([PaymentHandleKind.PayPal]);
    });

    it('survives a payload with no handles array at all', () => {
        expect(parsePayload('{}')).toEqual({version: 1, handles: []});
    });

    it('caps the handle list rather than trusting whatever was sealed', () => {
        const parsed = parsePayload(
            JSON.stringify({
                version: 1,
                handles: Array.from({length: 50}, () => ({kind: 'PayPal', value: 'anna'})),
            }),
        );
        expect(parsed.handles).toHaveLength(HANDLE_LIMITS.maxHandles);
    });

    it('truncates an over-long label rather than refusing the row', () => {
        const parsed = parsePayload(
            JSON.stringify({
                version: 1,
                handles: [{kind: 'PayPal', value: 'anna', label: 'x'.repeat(200)}],
            }),
        );
        expect(parsed.handles[0].label).toHaveLength(HANDLE_LIMITS.maxLabelLength);
    });
});
