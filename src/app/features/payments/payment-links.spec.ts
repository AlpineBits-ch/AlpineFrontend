import {describe, expect, it} from 'vitest';
import {buildPaymentLink, isLinkable, PAYPAL_FEE_WARNING, payPalLink, revolutLink} from './payment-links';
import {PaymentHandle, PaymentHandleKind} from './payment-handle.model';

function handle(kind: PaymentHandleKind, value: string): PaymentHandle {
    return {kind, value};
}

describe('payPalLink', () => {
    it('puts the amount and the ISO code in the path with no separator', () => {
        // PayPal's own help centre publishes this form: paypal.me/DiaRusso/25AUD.
        expect(payPalLink('annamuster', 4250, 'CHF').url)
            .toBe('https://paypal.me/annamuster/42.50CHF');
    });

    it('always appends the currency, because omitting it silently changes the number', () => {
        // Without a code the amount is read in the RECIPIENT's default currency, which in a
        // mixed-nationality flatshare produces a wrong figure rather than an error.
        const link = payPalLink('annamuster', 2500, 'EUR');
        expect(link.url).toContain('25.00EUR');
        expect(link.carriesCurrency).toBe(true);
    });

    it('falls back to a bare profile link when there is no amount', () => {
        const link = payPalLink('annamuster', null, 'CHF');
        expect(link.url).toBe('https://paypal.me/annamuster');
        expect(link.carriesAmount).toBe(false);
        // No amount means no fee exposure to warn about, so the warning is not shown either.
        expect(link.warnings).toEqual([]);
    });

    it('treats a zero amount as no amount rather than sending someone to pay nothing', () => {
        expect(payPalLink('annamuster', 0, 'CHF').url).toBe('https://paypal.me/annamuster');
    });

    /**
     * The most important commercial caveat in the feature. There is no URL parameter that selects
     * friends-and-family, the type is a recipient-side profile setting, and business accounts can
     * only accept goods-and-services at all. If it lands as goods-and-services the recipient pays
     * roughly 3%. Both facts are invisible to us, so the warning is unconditional on an
     * amount-bearing link.
     */
    it('warns about the fee on every amount-bearing link', () => {
        expect(payPalLink('annamuster', 4250, 'CHF').warnings).toContain(PAYPAL_FEE_WARNING);
    });

    it('warns that the payer can edit the amount', () => {
        expect(payPalLink('annamuster', 4250, 'CHF').warnings).toContain('amount-editable');
    });

    it('warns when no currency could be put in the link', () => {
        const link = payPalLink('annamuster', 4250, 'not-a-code');
        expect(link.carriesCurrency).toBe(false);
        expect(link.warnings).toContain('currency-unspecified');
    });

    it('respects a zero-decimal currency rather than inventing cents', () => {
        expect(payPalLink('annamuster', 2500, 'JPY').url)
            .toBe('https://paypal.me/annamuster/2500JPY');
    });

    it('escapes a handle rather than letting it alter the path', () => {
        expect(payPalLink('anna/../ben', null, 'CHF').url)
            .toBe('https://paypal.me/anna%2F..%2Fben');
    });
});

describe('revolutLink', () => {
    it('carries the Revtag and nothing else', () => {
        // There is no ?amount= parameter. An amount-bearing Revolut link is minted by the
        // recipient inside their app, per request, and cannot be constructed by a third party.
        const link = revolutLink('annamuster');
        expect(link.url).toBe('https://revolut.me/annamuster');
        expect(link.carriesAmount).toBe(false);
        expect(link.carriesCurrency).toBe(false);
    });
});

describe('buildPaymentLink', () => {
    it('builds one for PayPal and Revolut', () => {
        expect(buildPaymentLink(handle(PaymentHandleKind.PayPal, 'anna'), 100, 'CHF')).not.toBeNull();
        expect(buildPaymentLink(handle(PaymentHandleKind.Revolut, 'anna'), 100, 'CHF')).not.toBeNull();
    });

    it('builds none for the kinds that have no constructible link', () => {
        // Not a failure. An IBAN is paid by scanning its QR-bill or typing it into a bank; Wise
        // and Venmo have nothing a third party can construct. All three route to copyable text.
        for (const kind of [PaymentHandleKind.Iban, PaymentHandleKind.Wise,
            PaymentHandleKind.Venmo, PaymentHandleKind.Other]) {
            expect(buildPaymentLink(handle(kind, 'anna'), 100, 'CHF')).toBeNull();
            expect(isLinkable(handle(kind, 'anna'))).toBe(false);
        }
    });
});
