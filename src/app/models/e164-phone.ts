/**
 * The account phone number's shape, mirroring `Identity.Application.Services.E164PhoneNumber`.
 * Shape only: a normalised number is not a verified one, and no caller may treat it as one.
 */

/** E.164 caps the digits after the `+` at fifteen. */
export const E164_MAX_DIGITS = 15;

/** The floor, set below any real numbering plan: it is here to reject `+` and `+1`. */
export const E164_MIN_DIGITS = 6;

/** Presentation characters people paste off a contact card, U+00A0 very much included. */
const SEPARATOR = /[ \-.()\u00A0]/;

/** Why a string is not storable as a phone number, in the terms the user has to act on. */
export type E164Problem =
    /** Nothing typed. Not an error while the box is untouched; the caller decides. */
    | 'empty'
    /** No leading `+`, which is the `079...` and `0041...` case and by far the most common. */
    | 'no-plus'
    /** A character that is neither a digit nor a separator. */
    | 'not-a-number'
    /** Fewer digits than any number in service. */
    | 'too-short'
    /** More than E.164 allows. */
    | 'too-long'
    /** A leading zero after the `+`. No country code begins with one. */
    | 'trunk-prefix';

export interface E164Check {
    /** The canonical form, or null when {@link problem} is set. */
    e164: string | null;
    problem: E164Problem | null;
}

/** Canonicalises `candidate`, or explains why it cannot be. A leading `00` is refused, never rewritten. */
export function checkE164(candidate: string | null | undefined): E164Check {
    const trimmed = (candidate ?? '').trim();
    if (!trimmed) return {e164: null, problem: 'empty'};

    if (trimmed[0] !== '+') return {e164: null, problem: 'no-plus'};

    let digits = '';
    for (const character of trimmed.slice(1)) {
        if (character >= '0' && character <= '9') {
            digits += character;
            continue;
        }

        // Separators are dropped; anything else is refused rather than skipped past.
        if (SEPARATOR.test(character)) continue;

        return {e164: null, problem: 'not-a-number'};
    }

    if (digits.length < E164_MIN_DIGITS) return {e164: null, problem: 'too-short'};
    if (digits.length > E164_MAX_DIGITS) return {e164: null, problem: 'too-long'};
    if (digits[0] === '0') return {e164: null, problem: 'trunk-prefix'};

    return {e164: `+${digits}`, problem: null};
}

/** The canonical form, or null. The shorthand for callers that do not need the reason. */
export function normalizeE164(candidate: string | null | undefined): string | null {
    return checkE164(candidate).e164;
}

/** The translation key for a problem, so a template can render it without a switch. */
export function e164ProblemKey(problem: E164Problem): string {
    return `ACCOUNT.PHONE.PROBLEM.${problem.toUpperCase().replace(/-/g, '_')}`;
}

/** Every problem this module can report, for the copy test that pins a string behind each. */
export const E164_PROBLEMS: readonly E164Problem[] = [
    'empty', 'no-plus', 'not-a-number', 'too-short', 'too-long', 'trunk-prefix',
];
