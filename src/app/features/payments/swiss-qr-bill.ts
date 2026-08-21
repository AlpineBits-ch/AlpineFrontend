import {checkIban} from './iban';
import {minorToInputString} from '../../helpers/money.helper';

/** The Swiss Payments Code: the payload of a Swiss QR-bill, built entirely on the payer's device. */

/** Literal, and never derived from a version constant - see the class note. */
const QR_TYPE = 'SPC';
const VERSION = '0200';
/** `1` is UTF-8, which is the only coding type in practice. */
const CODING_TYPE = '1';
/** Structured. `K` (combined) has not been permitted since 21 November 2025. */
const ADDRESS_TYPE_STRUCTURED = 'S';
/**
 * No reference. A private person holds an ordinary IBAN, and an ordinary IBAN pairs with `NON`
 * (or `SCOR`); `QRR` belongs to a QR-IBAN and would be rejected against this one.
 */
const REFERENCE_TYPE_NONE = 'NON';
const TRAILER = 'EPD';

/** C0 and C1 controls, plus the Unicode line and paragraph separators. */
function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 0x1f) return true;
        if (code >= 0x7f && code <= 0x9f) return true;
        if (code === 0x2028 || code === 0x2029) return true;
    }
    return false;
}

/** The full field count. We emit through `EPD` at line 31 and leave 32-34 off. */
export const SPC_LINE_COUNT = 34;
export const SPC_TRAILER_LINE = 31;

/** SIX caps the encoded data. A payload over this does not scan reliably at the printed size. */
export const SPC_MAX_CHARACTERS = 997;

/** Error correction level the specification mandates, and which the Swiss cross overlay needs. */
export const SPC_ERROR_CORRECTION = 'M' as const;

/** Only these two. A EUR QR-bill is legal; a USD or GBP one does not exist. */
export const SPC_CURRENCIES = ['CHF', 'EUR'] as const;
export type SpcCurrency = (typeof SPC_CURRENCIES)[number];

/** Per-field maxima, straight from the field table. */
const MAX = {
    name: 70,
    street: 70,
    buildingNumber: 16,
    postCode: 16,
    town: 35,
    country: 2,
    message: 140,
} as const;

/** The smallest and largest amounts the field accepts, in minor units of a two-digit currency. */
export const SPC_MIN_AMOUNT_MINOR = 1;
export const SPC_MAX_AMOUNT_MINOR = 99_999_999_999;

export interface SwissQrCreditor {
    /** IBAN, CH or LI only. Spaces are tolerated on the way in and stripped. */
    iban: string;
    name: string;
    street?: string;
    buildingNumber?: string;
    postCode: string;
    town: string;
    /** ISO 3166-1 alpha-2. The creditor's country, which is not required to be CH. */
    country: string;
}

export interface SwissQrBillInput {
    creditor: SwissQrCreditor;
    /** Whole minor units, or null for an open amount the payer fills in themselves. */
    amountMinor: number | null;
    currency: SpcCurrency;
    /** The unstructured message, e.g. the expense description. Optional, capped at 140. */
    message?: string;
}

/** A refusal to build a payload, always naming the field. Never rendered as a generic failure. */
export class SwissQrBillError extends Error {
    constructor(
        readonly field: string,
        message: string,
    ) {
        super(message);
        this.name = 'SwissQrBillError';
    }
}

/** Builds the Swiss Payments Code payload, or throws. */
export function buildSwissQrBillPayload(input: SwissQrBillInput): string {
    const creditor = validateCreditor(input.creditor);
    const currency = validateCurrency(input.currency);
    const amount = formatAmount(input.amountMinor, currency);
    const message = validateMessage(input.message ?? '');

    const lines: string[] = [
        QR_TYPE, // 1
        VERSION, // 2
        CODING_TYPE, // 3
        creditor.iban, // 4
        ADDRESS_TYPE_STRUCTURED, // 5
        creditor.name, // 6
        creditor.street, // 7
        creditor.buildingNumber, // 8
        creditor.postCode, // 9
        creditor.town, // 10
        creditor.country, // 11

        // 12-18, the ultimate creditor: address type plus six address fields, all empty. Seven
        // lines, not six. This is the block the brief's ASCII snippets get wrong, and getting it
        // wrong shifts the amount and the currency onto the wrong lines.
        '',
        '',
        '',
        '',
        '',
        '',
        '',

        amount, // 19
        currency, // 20

        // 21-27, the ultimate debtor. Left empty: naming the payer would put a second person's
        // address in a QR code that gets shared, and the field buys nothing for a settle-up.
        '',
        '',
        '',
        '',
        '',
        '',
        '',

        REFERENCE_TYPE_NONE, // 28
        '', // 29 - must be empty when the type is NON
        message, // 30
        TRAILER, // 31
    ];

    if (lines.length !== SPC_TRAILER_LINE) {
        // Unreachable, and deliberately loud if it ever is not: an off-by-one in the blank blocks
        // above is the single most likely way to break this file, and it is invisible in review.
        throw new SwissQrBillError(
            'structure',
            `The payload has ${lines.length} lines rather than ${SPC_TRAILER_LINE}`,
        );
    }

    // LF, never CRLF. Every implementation checked emits LF, and scanner tolerance of CRLF is not
    // documented anywhere - so there is no reason to be the one client that finds out.
    const payload = lines.join('\n');

    if (payload.length > SPC_MAX_CHARACTERS) {
        throw new SwissQrBillError(
            'payload',
            `The payload is ${payload.length} characters, over the ${SPC_MAX_CHARACTERS} limit`,
        );
    }

    return payload;
}

/** Whether a QR-bill is possible at all for this pairing, without building one. */
export function swissQrUnavailableReason(
    iban: string,
    currency: string,
): 'ok' | 'iban-invalid' | 'iban-not-swiss' | 'currency' {
    const check = checkIban(iban);
    if (!check.valid) return 'iban-invalid';
    if (check.country !== 'CH' && check.country !== 'LI') return 'iban-not-swiss';
    if (!(SPC_CURRENCIES as readonly string[]).includes(currency.toUpperCase())) return 'currency';
    return 'ok';
}

// ── Field validation ────────────────────────────────────────────────────────

function validateCreditor(creditor: SwissQrCreditor): Required<SwissQrCreditor> {
    const iban = checkIban(creditor.iban);
    if (!iban.valid) {
        throw new SwissQrBillError('iban', 'The creditor IBAN is not a valid IBAN');
    }
    if (iban.country !== 'CH' && iban.country !== 'LI') {
        throw new SwissQrBillError(
            'iban',
            `A Swiss QR-bill needs a CH or LI IBAN; this one is ${iban.country}`,
        );
    }

    const country = (creditor.country ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
        throw new SwissQrBillError('country', 'The creditor country must be a two-letter ISO code');
    }

    return {
        iban: iban.normalized,
        name: field('name', creditor.name, MAX.name, true),
        street: field('street', creditor.street ?? '', MAX.street, false),
        buildingNumber: field('buildingNumber', creditor.buildingNumber ?? '', MAX.buildingNumber, false),
        // Optional in the field table, mandatory in practice for a structured address: a payment
        // part with no town is what a bank app rejects at the counter rather than at the scan.
        postCode: field('postCode', creditor.postCode, MAX.postCode, true),
        town: field('town', creditor.town, MAX.town, true),
        country,
    };
}

function validateCurrency(currency: string): SpcCurrency {
    const code = (currency ?? '').trim().toUpperCase();
    if (!(SPC_CURRENCIES as readonly string[]).includes(code)) {
        throw new SwissQrBillError('currency', `A Swiss QR-bill carries CHF or EUR only, not ${currency}`);
    }
    return code as SpcCurrency;
}

function validateMessage(message: string): string {
    return field('message', message, MAX.message, false);
}

/** `4250` -> `"42.50"`: dot decimal, two places, no thousands separator, no sign. */
function formatAmount(amountMinor: number | null, currency: SpcCurrency): string {
    // Empty is legal and means the payer types their own amount. It is not the same as zero, which
    // is not a payable amount and which the field's own range refuses.
    if (amountMinor === null) return '';

    if (!Number.isSafeInteger(amountMinor)) {
        throw new SwissQrBillError('amount', 'The amount must be whole minor units');
    }
    if (amountMinor < SPC_MIN_AMOUNT_MINOR || amountMinor > SPC_MAX_AMOUNT_MINOR) {
        throw new SwissQrBillError(
            'amount',
            `The amount must be between ${SPC_MIN_AMOUNT_MINOR} and ${SPC_MAX_AMOUNT_MINOR} minor units`,
        );
    }

    return minorToInputString(amountMinor, currency);
}

/** Trims, checks the length, and refuses any control character. */
function field(name: string, value: string, max: number, required: boolean): string {
    const trimmed = (value ?? '').trim();

    if (required && !trimmed) {
        throw new SwissQrBillError(name, `The creditor ${name} is required`);
    }
    if (hasControlCharacter(trimmed)) {
        throw new SwissQrBillError(name, `The creditor ${name} contains a line break or control character`);
    }
    if (trimmed.length > max) {
        throw new SwissQrBillError(
            name,
            `The creditor ${name} is ${trimmed.length} characters, over the ${max} limit`,
        );
    }

    return trimmed;
}
