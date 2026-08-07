/**
 * The account phone number's shape, checked here so the user hears about a typo before the network
 * does.
 *
 * <p><b>A deliberate second copy of a server rule.</b> `Identity.Application.Services.E164PhoneNumber`
 * is the authority and still runs on every write; this exists because the round trip it saves is the
 * difference between "that is not a number this app can store, here is why" appearing under the box
 * as you leave it and a `400` arriving after a save. The two must agree, and the tests here are
 * written from the server's own cases so a drift shows up as a red test rather than as a form that
 * accepts something the server then refuses.</p>
 *
 * <p><b>Nothing here verifies anything.</b> It establishes that a string is shaped like an E.164
 * number. It cannot establish that the number exists, that it is in service, or that it belongs to
 * the person typing it - nothing in this system can, because there is no SMS step anywhere. No
 * caller may present a successfully normalised number as a checked one.</p>
 *
 * <p><b>Why not libphonenumber.</b> Real per-country validation needs a numbering-plan database that
 * has to be kept current, and it would still not tell us whose number it is. The server declined
 * that dependency for the same reason, and a client that validated more strictly than the server
 * would reject numbers the server would have happily stored.</p>
 */

/** E.164 caps the digits after the `+` at fifteen. */
export const E164_MAX_DIGITS = 15;

/**
 * The floor. Set below any real numbering plan on purpose: it is here to reject `+` and `+1`, not to
 * adjudicate plans this module has already declined to know about.
 */
export const E164_MIN_DIGITS = 6;

/** Presentation characters people paste off a contact card, U+00A0 very much included. */
const SEPARATOR = /[ \-.()\u00A0]/;

/**
 * Why a string is not storable as a phone number, in the terms the user has to act on.
 *
 * <p>Each of these maps to a sentence that says what to do. "Invalid phone number" is what this
 * type exists to avoid: the person who pasted `0041791234567` needs to be told about the `+`, and
 * the person who pasted a number with a letter in it needs to be told something else entirely.</p>
 */
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
    /**
     * A leading zero after the `+`.
     *
     * <p>No country code begins with one - it is a national trunk prefix that E.164 does not carry -
     * so this is `+0...`, and it is also where `00...` lands once somebody has "fixed" it by
     * sticking a `+` on the front.</p>
     */
    | 'trunk-prefix';

export interface E164Check {
    /** The canonical form, or null when {@link problem} is set. */
    e164: string | null;
    problem: E164Problem | null;
}

/**
 * Canonicalises `candidate`, or explains why it cannot be.
 *
 * <p><b>A leading `00` is refused rather than rewritten, and that is the decision most likely to be
 * argued with.</b> Mapping `00` to `+` is right in most of the world and wrong in enough of it that
 * a silent rewrite produces a valid-looking number belonging to a stranger. With nothing verifying
 * the result, a number the app quietly rewrote is a number nobody ever looked at - so the input asks
 * the user to write the `+` themselves rather than helpfully guessing at their dialling plan.</p>
 */
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

        // Separators are dropped; anything else is refused rather than skipped past. Silently
        // dropping a letter out of the middle of a number produces a different number that still
        // looks perfectly fine.
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

/**
 * The translation key for a problem, so a template can render it without a switch.
 *
 * <p>Built rather than tabulated so a new {@link E164Problem} member cannot be added without a key
 * appearing for it - `ACCOUNT.PHONE.PROBLEM.*` is asserted complete in `phone-copy.spec.ts`.</p>
 */
export function e164ProblemKey(problem: E164Problem): string {
    return `ACCOUNT.PHONE.PROBLEM.${problem.toUpperCase().replace(/-/g, '_')}`;
}

/** Every problem this module can report, for the copy test that pins a string behind each. */
export const E164_PROBLEMS: readonly E164Problem[] = [
    'empty', 'no-plus', 'not-a-number', 'too-short', 'too-long', 'trunk-prefix',
];
