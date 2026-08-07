/**
 * IBAN handling: normalisation, the ISO 7064 mod-97 check, and display grouping.
 *
 * <p><b>This check used to be the server's and is now ours alone.</b> The payment-handle blob is
 * sealed before it leaves the device, so nothing on the other side can read an IBAN, let alone
 * validate one. A mistyped IBAN does not bounce back from this client, from the API or from the
 * bank on the day it is typed - it either fails a week later, or it reaches whoever really owns the
 * account it turned into. Both are silent from here, which is why the check runs before the value
 * is ever stored and again before it is ever put in a QR payload.</p>
 *
 * <p>Mod-97 catches every single-character error and every transposition of adjacent characters,
 * which is the whole class of mistake a person makes copying twenty-one characters off a screen. It
 * does not prove the account exists, and nothing here should be worded as though it does.</p>
 */

/** ISO 13616 caps the printed form at 34; nothing shorter than Norway's 15 is a real IBAN. */
const MIN_LENGTH = 15;
const MAX_LENGTH = 34;

/**
 * Registered IBAN lengths, for the countries a European household plausibly banks in.
 *
 * <p>A length check rejects a truncated or over-typed IBAN that mod-97 would otherwise wave
 * through roughly one time in ninety-seven. Deliberately not exhaustive: an unlisted country is
 * checked by mod-97 alone rather than refused, because refusing an IBAN this table has simply not
 * heard of would be a worse failure than accepting one whose length we cannot confirm.</p>
 */
const LENGTH_BY_COUNTRY: Readonly<Record<string, number>> = {
    AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
    ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GI: 23, GL: 18, GR: 27, HR: 21, HU: 28,
    IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18,
    NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, TR: 26, VA: 22,
};

/** Why an IBAN was refused. The UI says which - "that is not a valid IBAN" is not actionable. */
export type IbanProblem =
    | 'empty'
    | 'charset'
    | 'length'
    | 'country-length'
    | 'checksum';

export interface IbanCheck {
    valid: boolean;
    /** The stored form: upper-case, no spaces. Present even when invalid, for re-display. */
    normalized: string;
    /** ISO 3166-1 alpha-2 prefix, or `''` when the value is too malformed to have one. */
    country: string;
    problem: IbanProblem | null;
}

/**
 * The canonical stored form: upper-case, with every space and separator removed.
 *
 * <p>People paste IBANs in the grouped form their bank prints, sometimes with non-breaking or
 * narrow spaces, and Swiss statements use them liberally. Everything that is not a letter or a
 * digit goes, so the value that is validated is the value that is stored is the value that goes
 * into the QR payload.</p>
 */
export function normalizeIban(input: string): string {
    return (input ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** `CH4431999123000889012` -> `CH44 3199 9123 0008 8901 2`, which is how it is read aloud. */
export function formatIban(input: string): string {
    return (normalizeIban(input).match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Full validation: shape, registered length, and the mod-97 checksum.
 *
 * <p>Order matters for the message. A value with a letter where a digit belongs is a charset
 * problem, not a failed checksum, and telling somebody their checksum is wrong when they typed an
 * `O` for a `0` sends them to re-check the wrong end of the number.</p>
 */
export function checkIban(input: string): IbanCheck {
    const normalized = normalizeIban(input);
    const country = /^[A-Z]{2}/.test(normalized) ? normalized.slice(0, 2) : '';

    if (!normalized) return {valid: false, normalized, country, problem: 'empty'};

    // Two letters, two check digits, then the country's own alphanumeric BBAN.
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalized)) {
        return {valid: false, normalized, country, problem: 'charset'};
    }
    if (normalized.length < MIN_LENGTH || normalized.length > MAX_LENGTH) {
        return {valid: false, normalized, country, problem: 'length'};
    }

    const expected = LENGTH_BY_COUNTRY[country];
    if (expected !== undefined && normalized.length !== expected) {
        return {valid: false, normalized, country, problem: 'country-length'};
    }

    return mod97(normalized) === 1
        ? {valid: true, normalized, country, problem: null}
        : {valid: false, normalized, country, problem: 'checksum'};
}

export function isValidIban(input: string): boolean {
    return checkIban(input).valid;
}

/** Whether this IBAN can be the creditor of a Swiss QR-bill, which is a CH or LI account only. */
export function isSwissQrEligibleIban(input: string): boolean {
    const check = checkIban(input);
    return check.valid && (check.country === 'CH' || check.country === 'LI');
}

/**
 * ISO 7064 MOD 97-10 over the rearranged IBAN.
 *
 * <p>Computed in chunks rather than as one integer: a 34-character IBAN expands to a 40-digit
 * number, and `Number` loses precision above 2^53, so the obvious one-line version silently returns
 * the wrong remainder for long IBANs and passes the short ones it was tested on. Nine digits at a
 * time keeps every intermediate under `Number.MAX_SAFE_INTEGER`.</p>
 */
function mod97(iban: string): number {
    // The first four characters move to the end, and letters become their position plus nine.
    const rearranged = iban.slice(4) + iban.slice(0, 4);

    let remainder = 0;
    let chunk = '';

    for (const char of rearranged) {
        chunk += char >= 'A' && char <= 'Z'
            ? String(char.charCodeAt(0) - 55)
            : char;

        if (chunk.length >= 9) {
            remainder = Number(String(remainder) + chunk) % 97;
            chunk = '';
        }
    }

    return chunk ? Number(String(remainder) + chunk) % 97 : remainder;
}
