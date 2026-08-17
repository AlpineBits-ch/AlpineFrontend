import {minorToInputString} from '../../helpers/money.helper';
import {capabilitiesOf, PaymentHandle, PaymentHandleKind} from './payment-handle.model';

/** Turning a stored handle plus an amount into a link the payer's own operating system can open. */

/** What was built, and what the user has to be told before they tap it. */
export interface PaymentLink {
    url: string;
    /** Whether the amount actually made it into the URL, or the payer has to type it. */
    carriesAmount: boolean;
    /** Whether the currency made it in. False means the recipient's default currency applies. */
    carriesCurrency: boolean;
    /** Warnings the UI must render next to the button, not swallow. */
    warnings: PaymentLinkWarning[];
}

export type PaymentLinkWarning =
    /** PayPal may treat an amount-bearing link as goods-and-services and charge the recipient. */
    | 'paypal-fee'
    /** The payer can edit the amount before sending, so the figure is a suggestion. */
    | 'amount-editable'
    /** No currency in the URL: the amount is read in the recipient's default currency. */
    | 'currency-unspecified';

/**
 * PayPal's fee exposure, stated in full because it is the single most important commercial caveat
 * in the whole feature.
 */
export const PAYPAL_FEE_WARNING = 'paypal-fee' as const;

/**
 * Builds a link for a handle, or null when the provider has no constructible one.
 *
 * @param amountMinor whole minor units, or null to send the payer to a bare profile link.
 */
export function buildPaymentLink(
    handle: PaymentHandle,
    amountMinor: number | null,
    currency: string,
): PaymentLink | null {
    switch (handle.kind) {
        case PaymentHandleKind.PayPal:
            return payPalLink(handle.value, amountMinor, currency);
        case PaymentHandleKind.Revolut:
            return revolutLink(handle.value);
        default:
            return null;
    }
}

/** `https://paypal.me/{handle}/{amount}{CURRENCY}`. */
export function payPalLink(
    handle: string,
    amountMinor: number | null,
    currency: string,
): PaymentLink {
    const code = normalizeCurrency(currency);
    const path = amountMinor !== null && amountMinor > 0
        ? `/${minorToInputString(amountMinor, code ?? 'CHF')}${code ?? ''}`
        : '';

    const warnings: PaymentLinkWarning[] = [];
    if (amountMinor !== null && amountMinor > 0) {
        warnings.push(PAYPAL_FEE_WARNING, 'amount-editable');
        if (!code) warnings.push('currency-unspecified');
    }

    return {
        url: `https://paypal.me/${encodeURIComponent(handle)}${path}`,
        carriesAmount: path !== '',
        carriesCurrency: path !== '' && !!code,
        warnings,
    };
}

/** `https://revolut.me/{revtag}`. Recipient only - the payer types the amount themselves. */
export function revolutLink(revtag: string): PaymentLink {
    return {
        url: `https://revolut.me/${encodeURIComponent(revtag)}`,
        carriesAmount: false,
        carriesCurrency: false,
        warnings: [],
    };
}

/** Whether the pay sheet should offer a link button for this handle at all. */
export function isLinkable(handle: PaymentHandle): boolean {
    return capabilitiesOf(handle.kind).linkable;
}

// ── Internals ───────────────────────────────────────────────────────────────

function normalizeCurrency(currency: string): string | null {
    const code = (currency ?? '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : null;
}
