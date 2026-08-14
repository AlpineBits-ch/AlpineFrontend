import {describe, expect, it} from 'vitest';
import {formatMinor, minorUnitDigits} from './money';

/**
 * The billing amounts, through the surface `billing.service.ts` and the checkout screens import.
 *
 * <p>These cases are the contract's own, not the ledger's: a plan price, a zero-decimal currency, a
 * proration credit and a zero. The implementation is shared with the household ledger on purpose
 * (see `money.ts`), so this file is the guard on the re-export and on the four shapes the billing
 * payloads actually contain.</p>
 */

/** ICU separates a currency code from its digits with a non-breaking space of a width CLDR moves. */
const flat = (value: string) => value.replace(new RegExp('[\\u00a0\\u202f\\u2009]', 'g'), ' ');

describe('billing amounts', () => {
    it('formats a plan price from minor units and the payload currency', () => {
        expect(flat(formatMinor(2900, 'usd', 'en-US'))).toBe('$29.00');
    });

    it('honours a currency with no minor unit: 2900 JPY is 2900 yen, not 29', () => {
        // The failure this exists to catch is a hardcoded divide by 100, which renders this
        // as 29.00 yen and understates the price by two orders of magnitude.
        expect(minorUnitDigits('jpy')).toBe(0);
        expect(flat(formatMinor(2900, 'jpy', 'en-US'))).toBe('¥2,900');
    });

    it('formats a proration credit as a credit', () => {
        // immediateChargeMinorUnits is negative on a downgrade, and so is a preview line.
        expect(flat(formatMinor(-1450, 'usd', 'en-US'))).toBe('-$14.50');
    });

    it('formats zero rather than emptiness', () => {
        expect(flat(formatMinor(0, 'usd', 'en-US'))).toBe('$0.00');
        expect(flat(formatMinor(0, 'jpy', 'en-US'))).toBe('¥0');
    });

    it('never uses a hardcoded symbol - the currency comes from the payload', () => {
        expect(flat(formatMinor(2900, 'eur', 'en-US'))).toBe('€29.00');
        expect(flat(formatMinor(2900, 'chf', 'en-US'))).toBe('CHF 29.00');
    });
});
