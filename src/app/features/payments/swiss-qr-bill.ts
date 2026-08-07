import {checkIban} from './iban';
import {minorToInputString} from '../../helpers/money.helper';

/**
 * The Swiss Payments Code: the payload of a Swiss QR-bill, built entirely on the payer's device.
 *
 * <p><b>This is the only free, official, person-to-person prefilled payment mechanism in
 * Switzerland, and it is why the settle-up feature works here at all.</b> TWINT has no
 * constructible link of any kind - its API is not public and not available on request, and its QR
 * codes carry a per-transaction server-minted pairing token that even TWINT's own certified SDK
 * cannot produce. The QR-bill, by contrast, is published by SIX, free to implement, needs no
 * agreement with anybody, makes no network call, and is scanned by every Swiss and Liechtenstein
 * banking app. It prefills both the recipient and the amount.</p>
 *
 * <p><b>Every failure of this file is silent and expensive.</b> A malformed payload does not throw
 * anywhere we can see it: the payer scans it in their own bank's app, days later, and either gets
 * an unhelpful rejection or - far worse - a payment that goes somewhere. So this generator refuses
 * rather than guesses, on every rule the specification states: a non-CH/LI IBAN throws, a currency
 * other than CHF or EUR throws, an over-long field throws, a newline anywhere in a field throws.
 * There is no lenient mode.</p>
 *
 * <p><b>Version.</b> Implementation Guidelines QR-bill v2.3, in force since 21 November 2025. The
 * version *inside* the payload is still `0200` - that encodes the 2.x generation, not the point
 * release, and writing `0230` there produces a payload no scanner accepts.</p>
 *
 * <h4>The 34-line structure, and the one place the brief's worked example is wrong</h4>
 *
 * <p>The line map is: 1 `SPC`, 2 version, 3 coding type, 4 IBAN, 5-11 creditor (address type plus
 * six fields), <b>12-18 ultimate creditor (seven fields)</b>, 19 amount, 20 currency, 21-27
 * ultimate debtor (seven fields), 28 reference type, 29 reference, 30 unstructured message,
 * 31 `EPD`, 32-34 billing information and the two alternative-scheme slots.</p>
 *
 * <p>The research document's prose line map and field table both say the ultimate-creditor block is
 * seven fields on lines 12-18, and they are right - the block is structurally identical to the
 * creditor block above it and to the ultimate-debtor block below it, and all three carry an address
 * type plus six address fields. <b>Its two copy-pasteable ASCII snippets, however, contain only six
 * blank lines there</b>, which shifts the amount, the currency and everything after them up by one
 * and produces a payload a bank app will reject. This file follows the line map and not the
 * snippets; {@link SPC_LINE_COUNT} and the tests pin the correct shape so the discrepancy cannot be
 * reintroduced by someone re-reading the snippet.</p>
 *
 * <p>The payload ends at the `EPD` trailer with no trailing newline. Lines 32-34 are optional
 * trailing elements, and we emit none of them: there is no Swico billing string to carry, and the
 * alternative-scheme slots are where a *registered* scheme such as TWINT's would go, which requires
 * being a TWINT merchant. Some implementations emit a trailing newline after `EPD`; both forms are
 * accepted, and omitting it matches the worked examples.</p>
 */

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

/**
 * C0 and C1 controls, plus the Unicode line and paragraph separators.
 *
 * <p>Written as escapes rather than as literal characters so the file stays readable text and the
 * check cannot be silently weakened by an editor normalising a byte nobody can see.</p>
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

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
    /**
     * Whole minor units, or null for an open amount the payer fills in themselves.
     *
     * <p>Integer, as everywhere else in the money path. The decimal string the payload wants is
     * produced by {@link minorToInputString}, which moves the point by slicing digits, so no amount
     * is ever a fractional `number` on the way to somebody's bank.</p>
     */
    amountMinor: number | null;
    currency: SpcCurrency;
    /** The unstructured message, e.g. the expense description. Optional, capped at 140. */
    message?: string;
}

/** A refusal to build a payload, always naming the field. Never rendered as a generic failure. */
export class SwissQrBillError extends Error {
    constructor(readonly field: string, message: string) {
        super(message);
        this.name = 'SwissQrBillError';
    }
}

/**
 * Builds the Swiss Payments Code payload, or throws.
 *
 * <p>Pure: no network, no clock, no randomness. The same input produces the same string forever,
 * which is what makes it testable against the specification's own worked examples.</p>
 */
export function buildSwissQrBillPayload(input: SwissQrBillInput): string {
    const creditor = validateCreditor(input.creditor);
    const currency = validateCurrency(input.currency);
    const amount = formatAmount(input.amountMinor, currency);
    const message = validateMessage(input.message ?? '');

    const lines: string[] = [
        QR_TYPE,                        // 1
        VERSION,                        // 2
        CODING_TYPE,                    // 3
        creditor.iban,                  // 4
        ADDRESS_TYPE_STRUCTURED,        // 5
        creditor.name,                  // 6
        creditor.street,                // 7
        creditor.buildingNumber,        // 8
        creditor.postCode,              // 9
        creditor.town,                  // 10
        creditor.country,               // 11

        // 12-18, the ultimate creditor: address type plus six address fields, all empty. Seven
        // lines, not six. This is the block the brief's ASCII snippets get wrong, and getting it
        // wrong shifts the amount and the currency onto the wrong lines.
        '', '', '', '', '', '', '',

        amount,                         // 19
        currency,                       // 20

        // 21-27, the ultimate debtor. Left empty: naming the payer would put a second person's
        // address in a QR code that gets shared, and the field buys nothing for a settle-up.
        '', '', '', '', '', '', '',

        REFERENCE_TYPE_NONE,            // 28
        '',                             // 29 - must be empty when the type is NON
        message,                        // 30
        TRAILER,                        // 31
    ];

    if (lines.length !== SPC_TRAILER_LINE) {
        // Unreachable, and deliberately loud if it ever is not: an off-by-one in the blank blocks
        // above is the single most likely way to break this file, and it is invisible in review.
        throw new SwissQrBillError(
            'structure', `The payload has ${lines.length} lines rather than ${SPC_TRAILER_LINE}`);
    }

    // LF, never CRLF. Every implementation checked emits LF, and scanner tolerance of CRLF is not
    // documented anywhere - so there is no reason to be the one client that finds out.
    const payload = lines.join('\n');

    if (payload.length > SPC_MAX_CHARACTERS) {
        throw new SwissQrBillError(
            'payload',
            `The payload is ${payload.length} characters, over the ${SPC_MAX_CHARACTERS} limit`);
    }

    return payload;
}

/**
 * Whether a QR-bill is possible at all for this pairing, without building one.
 *
 * <p>Used to decide whether to offer the QR tab. The two rules that most often rule it out are
 * structural rather than typos: a flatmate banking in Germany has a perfectly valid IBAN that this
 * scheme cannot carry, and a household keeping its ledger in GBP has a perfectly valid currency
 * that it cannot carry either.</p>
 */
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
            'iban', `A Swiss QR-bill needs a CH or LI IBAN; this one is ${iban.country}`);
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
        throw new SwissQrBillError(
            'currency', `A Swiss QR-bill carries CHF or EUR only, not ${currency}`);
    }
    return code as SpcCurrency;
}

function validateMessage(message: string): string {
    return field('message', message, MAX.message, false);
}

/**
 * `4250` -> `"42.50"`: dot decimal, two places, no thousands separator, no sign.
 *
 * <p>Produced from the integer by string surgery rather than by dividing by a hundred. `1234 / 100`
 * is `12.339999999999999857891...` in binary floating point, and a rounding rule laid over that is
 * a bug waiting for the first amount that lands the wrong side of a half-rappen - in a field that
 * ends up as the figure a bank actually moves.</p>
 */
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
            `The amount must be between ${SPC_MIN_AMOUNT_MINOR} and ${SPC_MAX_AMOUNT_MINOR} minor units`);
    }

    return minorToInputString(amountMinor, currency);
}

/**
 * Trims, checks the length, and refuses any control character.
 *
 * <p><b>The newline check is the important one and it is a security check, not a tidiness one.</b>
 * The payload is line-separated, so a line feed inside a creditor name would shift every field
 * after it and let whoever typed the name choose what the payer's bank shows in the amount and the
 * IBAN. The name is somebody else's typed input arriving through a sealed blob, and it must never
 * be interpolated into a line-structured format unchecked.</p>
 */
function field(name: string, value: string, max: number, required: boolean): string {
    const trimmed = (value ?? '').trim();

    if (required && !trimmed) {
        throw new SwissQrBillError(name, `The creditor ${name} is required`);
    }
    if (CONTROL_CHARACTERS.test(trimmed)) {
        throw new SwissQrBillError(
            name, `The creditor ${name} contains a line break or control character`);
    }
    if (trimmed.length > max) {
        throw new SwissQrBillError(
            name, `The creditor ${name} is ${trimmed.length} characters, over the ${max} limit`);
    }

    return trimmed;
}
