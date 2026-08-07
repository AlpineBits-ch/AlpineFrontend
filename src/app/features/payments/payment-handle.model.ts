import {checkIban, formatIban, normalizeIban} from './iban';

/**
 * The handle list that lives inside the sealed blob, and the rules that decide what may go in it.
 *
 * <p><b>Nothing here is on the server.</b> There is deliberately no `PaymentHandleKind` on the
 * other side: which provider somebody banks with is itself covered by the confidentiality
 * requirement, so the kind, the value and the label are all inside the ciphertext. That makes every
 * rule in this file the only rule there is - a value this file accepts is stored, and a value it
 * accepts wrongly is stored wrongly, with nothing downstream to catch it.</p>
 *
 * <p><b>Phone numbers are not a kind here, on purpose.</b> A TWINT number lives in Identity as the
 * account's `phoneNumber` behind a per-household opt-in, and a second copy sealed in this blob
 * would be a number that drifts from the real one with nothing able to read both and reconcile
 * them. {@link PaymentHandleKind} has no `Phone` member and should not grow one; see
 * `twint-assist.ts` for the seam that consumes the Identity value when it lands.</p>
 */

/** The providers the sealed list can describe. Wire values are the names, inside the ciphertext. */
export enum PaymentHandleKind {
    /** A bank account. The only kind that can produce a Swiss QR-bill. */
    Iban = 'Iban',
    PayPal = 'PayPal',
    Revolut = 'Revolut',
    Wise = 'Wise',
    Venmo = 'Venmo',
    /** Anything else, rendered as copyable text and never as a link. */
    Other = 'Other',
}

export const PAYMENT_HANDLE_KINDS: readonly PaymentHandleKind[] = [
    PaymentHandleKind.Iban,
    PaymentHandleKind.PayPal,
    PaymentHandleKind.Revolut,
    PaymentHandleKind.Wise,
    PaymentHandleKind.Venmo,
    PaymentHandleKind.Other,
] as const;

export interface PaymentHandle {
    kind: PaymentHandleKind;
    /** Normalised for the kind - see {@link normalizeHandleValue}. Never the raw typed string. */
    value: string;
    /** The owner's own note, e.g. "joint account". Optional, and shown verbatim. */
    label?: string;
}

/**
 * The creditor details a Swiss QR-bill needs, which an IBAN alone does not carry.
 *
 * <p>Collected only from people who actually add an IBAN, and only because the Swiss Payments Code
 * makes a structured address mandatory. It is a home address, so it is asked for once, at the point
 * it becomes necessary, rather than up front from everyone.</p>
 */
export interface CreditorAddress {
    name: string;
    street?: string;
    buildingNumber?: string;
    postCode: string;
    town: string;
    /** ISO 3166-1 alpha-2, upper-case. */
    country: string;
}

/** The whole plaintext payload. Versioned so the envelope can be re-read after a schema change. */
export interface PaymentHandlePayload {
    version: 1;
    handles: PaymentHandle[];
    /** Present only when at least one handle is an IBAN. */
    creditor?: CreditorAddress;
}

/**
 * What a provider's link can and cannot express, from the research in
 * `payment-deeplink-research.md` section 3.D.
 *
 * <p>Modelled per provider rather than assumed universal, because it is not: of everything in the
 * set only PayPal.Me carries a currency, only Swish can lock an amount so the payer cannot change
 * it, and Revolut and Wise cannot carry an amount at all. A UI that assumed `(handle, amount,
 * currency)` was expressible everywhere would show an amount on a Revolut link that silently is not
 * there when the payer arrives.</p>
 */
export interface HandleCapabilities {
    /** Whether a link can be constructed at all from a stored handle. */
    linkable: boolean;
    canPrefillAmount: boolean;
    canPrefillCurrency: boolean;
    canPrefillNote: boolean;
    /**
     * Whether the amount is locked against payer edits. False everywhere we ship: Swish is the only
     * provider in the entire research set that can lock one, and we do not ship Sweden.
     */
    canLockAmount: boolean;
}

const CAPABILITIES: Readonly<Record<PaymentHandleKind, HandleCapabilities>> = {
    // Not a link: an IBAN is paid by scanning the Swiss QR-bill built from it, or by typing it into
    // a bank. `payto:` (RFC 8905) would be the natural URI and has no handlers anywhere.
    [PaymentHandleKind.Iban]: {
        linkable: false, canPrefillAmount: false, canPrefillCurrency: false,
        canPrefillNote: false, canLockAmount: false,
    },
    // The one officially documented consumer link with both an amount and a currency.
    [PaymentHandleKind.PayPal]: {
        linkable: true, canPrefillAmount: true, canPrefillCurrency: true,
        canPrefillNote: false, canLockAmount: false,
    },
    // revolut.me carries the Revtag and nothing else. An amount-bearing Revolut link is minted by
    // the recipient inside their app, per request, and cannot be constructed by us.
    [PaymentHandleKind.Revolut]: {
        linkable: true, canPrefillAmount: false, canPrefillCurrency: false,
        canPrefillNote: false, canLockAmount: false,
    },
    // Wise publishes an open link for **business** accounts only. Personal money requests are
    // recipient-minted and expire after 30 days, and the Wisetag URL format is not published at all,
    // so there is nothing here a third party can build. Displayed, never linked.
    [PaymentHandleKind.Wise]: {
        linkable: false, canPrefillAmount: false, canPrefillCurrency: false,
        canPrefillNote: false, canLockAmount: false,
    },
    // Reverse-engineered from the app binary, undocumented since forever, US-only and USD-only.
    // Shipped as a stored handle that renders as text; see `payment-links.ts` for why no link.
    [PaymentHandleKind.Venmo]: {
        linkable: false, canPrefillAmount: false, canPrefillCurrency: false,
        canPrefillNote: false, canLockAmount: false,
    },
    [PaymentHandleKind.Other]: {
        linkable: false, canPrefillAmount: false, canPrefillCurrency: false,
        canPrefillNote: false, canLockAmount: false,
    },
};

export function capabilitiesOf(kind: PaymentHandleKind): HandleCapabilities {
    return CAPABILITIES[kind] ?? CAPABILITIES[PaymentHandleKind.Other];
}

/** Why a handle was refused, for a message that names the actual problem. */
export type HandleProblem =
    | 'empty'
    | 'charset'
    | 'too-long'
    | 'too-short'
    | 'iban-charset'
    | 'iban-length'
    | 'iban-country-length'
    | 'iban-checksum';

export interface HandleCheck {
    valid: boolean;
    /** What would be stored. Always present, so a rejected value can still be echoed back. */
    normalized: string;
    problem: HandleProblem | null;
}

export const HANDLE_LIMITS = {
    /** Enough for a household; the sealed blob is capped at 8 KiB server-side either way. */
    maxHandles: 12,
    maxLabelLength: 40,
    maxOtherLength: 140,
    /** Every structured field the Swiss Payments Code carries has its own cap; this is the widest. */
    maxNameLength: 70,
} as const;

/**
 * Per-provider charsets.
 *
 * <p>Sourced, not guessed. Getting one of these wrong in the permissive direction stores a handle
 * that produces a dead link; getting it wrong in the strict direction refuses somebody's real
 * username. Where a provider does not publish a rule the pattern is deliberately wide, because
 * refusing a real handle is the worse of the two failures.</p>
 */
const PATTERNS: Partial<Record<PaymentHandleKind, {re: RegExp; min: number; max: number}>> = {
    // PayPal.Me handles are alphanumeric and capped at 20 by the profile picker.
    [PaymentHandleKind.PayPal]: {re: /^[A-Za-z0-9]+$/, min: 1, max: 20},
    // Revtags are alphanumeric. Shown with a leading @, which `normalizeHandleValue` strips.
    [PaymentHandleKind.Revolut]: {re: /^[A-Za-z0-9]+$/, min: 3, max: 16},
    // Wisetag: the format is not published, so this is permissive on purpose.
    [PaymentHandleKind.Wise]: {re: /^[A-Za-z0-9._-]+$/, min: 1, max: 50},
    [PaymentHandleKind.Venmo]: {re: /^[A-Za-z0-9_-]+$/, min: 5, max: 30},
};

/**
 * The stored form of a typed value.
 *
 * <p>Idempotent for every kind, which is what lets the editor normalise on blur without the value
 * drifting each time the field is touched. An `@` prefix is stripped rather than refused: it is how
 * every one of these providers displays the handle, so it is what people paste.</p>
 */
export function normalizeHandleValue(kind: PaymentHandleKind, raw: string): string {
    const trimmed = (raw ?? '').trim();

    switch (kind) {
        case PaymentHandleKind.Iban:
            return normalizeIban(trimmed);
        case PaymentHandleKind.PayPal:
        case PaymentHandleKind.Revolut:
        case PaymentHandleKind.Wise:
        case PaymentHandleKind.Venmo:
            // A pasted profile URL is a handle with a prefix. Taking the last path segment is worth
            // it: "paypal.me/annamuster" is what people copy, and refusing it teaches them to
            // hand-edit the field, which is where the typos come from.
            return stripHandleDecoration(trimmed);
        case PaymentHandleKind.Other:
            return trimmed;
    }
}

/** Validates the normalised value for its kind. Never call this on a raw typed string. */
export function checkHandleValue(kind: PaymentHandleKind, raw: string): HandleCheck {
    const normalized = normalizeHandleValue(kind, raw);
    if (!normalized) return {valid: false, normalized, problem: 'empty'};

    if (kind === PaymentHandleKind.Iban) {
        const iban = checkIban(normalized);
        if (iban.valid) return {valid: true, normalized: iban.normalized, problem: null};
        return {
            valid: false,
            normalized: iban.normalized,
            problem: iban.problem === 'checksum' ? 'iban-checksum'
                : iban.problem === 'country-length' ? 'iban-country-length'
                    : iban.problem === 'length' ? 'iban-length'
                        : 'iban-charset',
        };
    }

    if (kind === PaymentHandleKind.Other) {
        return normalized.length > HANDLE_LIMITS.maxOtherLength
            ? {valid: false, normalized, problem: 'too-long'}
            : {valid: true, normalized, problem: null};
    }

    const rule = PATTERNS[kind];
    if (!rule) return {valid: true, normalized, problem: null};

    if (!rule.re.test(normalized)) return {valid: false, normalized, problem: 'charset'};
    if (normalized.length < rule.min) return {valid: false, normalized, problem: 'too-short'};
    if (normalized.length > rule.max) return {valid: false, normalized, problem: 'too-long'};

    return {valid: true, normalized, problem: null};
}

/** How a stored handle is shown: an IBAN grouped in fours, everything else verbatim. */
export function displayHandleValue(handle: PaymentHandle): string {
    return handle.kind === PaymentHandleKind.Iban ? formatIban(handle.value) : handle.value;
}

/**
 * Parses a decrypted payload, keeping only what this build understands.
 *
 * <p>Defensive because the input is a blob some other client wrote: a newer Alpine may have sealed
 * a kind this build has never heard of, and the right answer is to drop that one row rather than
 * fail to open the whole payload and tell the user their flatmate has shared nothing.</p>
 */
export function parsePayload(json: string): PaymentHandlePayload {
    const raw = JSON.parse(json) as Partial<PaymentHandlePayload>;
    const known = new Set<string>(PAYMENT_HANDLE_KINDS);

    const handles = (Array.isArray(raw.handles) ? raw.handles : [])
        .filter((h): h is PaymentHandle =>
            !!h && typeof h.value === 'string' && known.has(h.kind as string))
        .slice(0, HANDLE_LIMITS.maxHandles)
        .map(h => ({
            kind: h.kind,
            value: h.value,
            ...(h.label ? {label: String(h.label).slice(0, HANDLE_LIMITS.maxLabelLength)} : {}),
        }));

    return {version: 1, handles, ...(raw.creditor ? {creditor: raw.creditor} : {})};
}

/** The bytes that get sealed. Stable key order so an unchanged list re-seals to the same plaintext. */
export function serializePayload(payload: PaymentHandlePayload): string {
    return JSON.stringify({
        version: 1,
        handles: payload.handles.map(h => ({
            kind: h.kind,
            value: h.value,
            ...(h.label ? {label: h.label} : {}),
        })),
        ...(payload.creditor ? {creditor: payload.creditor} : {}),
    });
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Reduces a pasted profile link or an `@handle` to the bare handle.
 *
 * <p>Anything that looks like a URL keeps its last non-empty path segment, with the query and
 * fragment dropped. That is exactly right for `paypal.me/anna`, `revolut.me/anna`,
 * `wise.com/pay/me/@anna` and `venmo.com/anna`, and harmless for a bare handle, which has no
 * slashes to split on.</p>
 */
function stripHandleDecoration(input: string): string {
    const withoutQuery = input.split(/[?#]/, 1)[0] ?? '';
    const segments = withoutQuery.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    return last.replace(/^[@$]/, '');
}
