import {minorToInputString} from '../../helpers/money.helper';
import {capabilitiesOf, PaymentHandle, PaymentHandleKind} from './payment-handle.model';

/**
 * Turning a stored handle plus an amount into a link the payer's own operating system can open.
 *
 * <p><b>The set of providers that can express `(handle, amount)` in a third-party-constructed URL
 * is much smaller than it looks</b>, and the research that established it is worth not repeating:
 * of every consumer wallet examined, only PayPal.Me, Cash App, Swish and Monzo can, and only
 * PayPal.Me can also carry a currency. Revolut's amount-bearing links are minted by the recipient
 * in-app; Wise publishes an open link for business accounts only and never publishes the Wisetag
 * URL format at all; Venmo's scheme is reverse-engineered from the app binary, undocumented, and
 * has already been reported broken once. So this file constructs exactly one link.</p>
 *
 * <p><b>No link returns a result.</b> Confirmed for every provider in the set: there is no callback
 * carrying a status without a merchant agreement. Every flow that starts here therefore ends with
 * the payer explicitly saying they paid, and the ledger records that assertion. Nothing in this
 * module may be worded as though a hand-off were evidence of a payment.</p>
 *
 * <p><b>And no wallet probing.</b> `canOpenURL` is deprecated as of iOS 27 and the declarable
 * scheme cap drops from fifty to twenty-five, which TWINT alone would have exhausted. It never
 * worked for `https` links in any case, because the answer reflects whether a *browser* is
 * registered. The user picks their wallet once, in settings, and we honour it: see
 * {@link import('./wallet-preference.service').WalletPreferenceService}.</p>
 */

/** What was built, and what the user has to be told before they tap it. */
export interface PaymentLink {
    url: string;
    /** Whether the amount actually made it into the URL, or the payer has to type it. */
    carriesAmount: boolean;
    /** Whether the currency made it in. False means the recipient's default currency applies. */
    carriesCurrency: boolean;
    /**
     * Warnings the UI must render next to the button, not swallow.
     *
     * <p>Not decoration. {@link PAYPAL_FEE_WARNING} is the difference between a settle-up that
     * costs nothing and one that quietly takes about three per cent off the person being repaid.</p>
     */
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
 *
 * <p>There is <b>no URL parameter</b> that selects friends-and-family. The payment type is a
 * recipient-side profile setting, and PayPal's own FAQ states plainly that business accounts can
 * only accept goods-and-services - so for a flatmate whose PayPal is a business account,
 * friends-and-family is impossible through a PayPal.Me link at all. If it lands as goods-and-
 * services the <i>recipient</i> pays roughly 2.99% plus a fixed fee. Both the account type and the
 * profile setting are invisible to us, so we cannot detect which applies, and the UI must say so
 * rather than imply a free transfer.</p>
 */
export const PAYPAL_FEE_WARNING = 'paypal-fee' as const;

/**
 * Builds a link for a handle, or null when the provider has no constructible one.
 *
 * <p>Null is the ordinary answer for most kinds and is not a failure - it routes the UI to the
 * copy-the-details path, which is what an IBAN, a Wisetag and a Revtag-without-an-amount all
 * genuinely deserve.</p>
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

/**
 * `https://paypal.me/{handle}/{amount}{CURRENCY}`.
 *
 * <p>The amount and the ISO code are a <b>path segment</b> concatenated with no separator, which is
 * the form PayPal's own help centre publishes. The currency code is always appended when we have
 * one: without it the amount is interpreted in the <i>recipient's</i> default currency, which in a
 * mixed-nationality flatshare silently produces the wrong number rather than an error.</p>
 */
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

/**
 * `https://revolut.me/{revtag}`. Recipient only - the payer types the amount themselves.
 *
 * <p>There is no `?amount=` parameter; searched for specifically and not found in Revolut's
 * documentation or anywhere else. An amount-bearing Revolut link exists but is created inside the
 * recipient's own app, per request.</p>
 *
 * <p>One trap worth knowing rather than designing around: the link is bound to Revtag
 * discoverability, which the owner can switch off, at which point a handle we stored months ago
 * silently stops resolving. That is a dead link, not a wrong payment, so it is left to fail
 * visibly.</p>
 */
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
