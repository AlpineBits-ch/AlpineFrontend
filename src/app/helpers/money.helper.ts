/**
 * Money, as whole minor units and nothing else.
 *
 * <p>Every amount the ledger touches - `amountMinor`, a share, a balance, a settlement - is an
 * integer number of rappen/cents. That is what makes shares sum to their total and balances sum to
 * exactly zero, and the server does its arithmetic the same way, so the two only agree while the
 * client keeps out of floating point entirely.</p>
 *
 * <p>Hence the shape of this file: a string goes in, an integer comes out, and an integer goes in
 * and a string comes out. Nothing here divides by 100 and nothing multiplies by it either - the
 * decimal point is moved by slicing and padding digit strings, which is exact by construction.
 * `1234 / 100` is `12.339999999999999857891...`, and a rounding rule built on top of that is a bug
 * waiting for the first amount that lands the wrong side of a half-cent.</p>
 */

/** What most of the world's currencies use, and what an unrecognised code is assumed to be. */
const DEFAULT_MINOR_DIGITS = 2;

/**
 * Characters that only ever separate thousands, never decimals. JavaScript's whitespace class
 * already covers every space width including the non-breaking and narrow ones Intl groups with, so
 * only the apostrophe forms - Switzerland's grouping mark, straight and curly - have to be named.
 */
const GROUPING_NOISE = /[\s'\u2019\u00b4]/g;

const digitsByCurrency = new Map<string, number>();
const groupSeparatorByLocale = new Map<string, string | null>();

/**
 * The ISO-4217 exponent for a currency: 2 for CHF and EUR, 0 for JPY, 3 for KWD.
 *
 * <p>Read off `Intl` rather than kept as a table here, because the engine already ships the ISO
 * exponent list and a hand-maintained copy of it is one PR away from disagreeing with the server
 * about what a Kuwaiti dinar's minor unit is. A code `Intl` rejects outright falls back to two
 * digits rather than throwing - a ledger with a typo in its currency should still render.</p>
 */
export function minorUnitDigits(currency: string): number {
    const code = (currency ?? '').trim().toUpperCase();
    const cached = digitsByCurrency.get(code);
    if (cached !== undefined) return cached;

    let digits = DEFAULT_MINOR_DIGITS;
    try {
        digits = new Intl.NumberFormat('en', {style: 'currency', currency: code})
            .resolvedOptions().minimumFractionDigits ?? DEFAULT_MINOR_DIGITS;
    } catch {
        // Not a shape Intl accepts as a currency code at all. Two digits, and move on.
    }
    digitsByCurrency.set(code, digits);
    return digits;
}

/**
 * `1234, 'CHF'` -> `"CHF 1'234.00"`, in the viewer's locale.
 *
 * <p>The digits are assembled by hand and only the *decoration* comes from `Intl`: a `±1` is
 * formatted as currency purely to learn where this locale puts the symbol, the spacing, the sign
 * and the decimal mark, and the integer and fraction parts of that template are then swapped for
 * the real ones. So no amount is ever converted to a fractional `number`, and an amount larger than
 * `Number.MAX_SAFE_INTEGER` still renders its exact digits.</p>
 */
export function formatMinor(amountMinor: number, currency: string, locale?: string): string {
    const digits = minorUnitDigits(currency);
    const negative = amountMinor < 0;
    const abs = Math.abs(Math.trunc(amountMinor));

    // padStart guarantees at least one integer digit, so 5 rappen reads "0.05" and not ".05".
    const raw = String(abs).padStart(digits + 1, '0');
    const wholeDigits = raw.slice(0, raw.length - digits);
    const fraction = digits > 0 ? raw.slice(raw.length - digits) : '';

    const grouped = new Intl.NumberFormat(locale, {maximumFractionDigits: 0})
        .format(Number(wholeDigits));

    const template = currencyFormatter(currency, digits, locale);
    if (template) return assemble(template.formatToParts(negative ? -1 : 1), grouped, fraction);

    // Intl would not take the code. Fall back to a plain number with the code in front, which is
    // still readable and still exact - it just loses the locale's idea of symbol placement.
    const plain = new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
    return `${currency} ${assemble(plain.formatToParts(negative ? -1 : 1), grouped, fraction)}`;
}

/**
 * User input -> whole minor units, or `null` when it is not a number this currency can hold.
 *
 * <p>Accepts what people actually type: `1234.5`, `1'234.50`, `1 234,50`, `-12`, `1,234.56`.
 * Grouping marks that are unambiguous - spaces, apostrophes - are dropped before anything else is
 * decided; `.` and `,` are then resolved by structure:</p>
 *
 * <ul>
 *   <li>both present: the last one is the decimal mark, the other is grouping ("1,234.56");</li>
 *   <li>one kind, repeated: all grouping, there is no other reading ("1.234.567");</li>
 *   <li>one kind, once: a decimal mark, unless it is followed by exactly three digits and the
 *       viewer's locale groups with that character - `"1,234"` in en-US is a thousand, not one and
 *       a bit.</li>
 * </ul>
 *
 * <p>Anything still ambiguous is rejected rather than guessed at, because the two readings of
 * `"1.234"` differ by a factor of a thousand and the wrong one is a silent 1000x error in someone's
 * rent. Excess precision is rejected for the same reason, with one exception: trailing zeros carry
 * no value, so `"12.500"` in a two-digit currency is 1250 rather than an error.</p>
 */
export function parseMinor(input: string, currency: string, locale?: string): number | null {
    const digits = minorUnitDigits(currency);
    const raw = (input ?? '').replace(GROUPING_NOISE, '');
    if (!raw) return null;

    const signed = raw.startsWith('-') || raw.startsWith('+');
    const negative = raw.startsWith('-');
    const body = signed ? raw.slice(1) : raw;

    // A separator must have digits on its right; a bare "12." or "1,,2" is not a number.
    if (!/^\d*(?:[.,]\d+)*$/.test(body) || !/\d/.test(body)) return null;

    const separators: number[] = [];
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '.' || body[i] === ',') separators.push(i);
    }

    let decimalIndex = -1;
    if (separators.length === 1) {
        decimalIndex = separators[0];
    } else if (separators.length > 1) {
        const kinds = new Set(separators.map(i => body[i]));
        decimalIndex = kinds.size > 1 ? separators[separators.length - 1] : -1;
    }

    let fraction = decimalIndex >= 0 ? body.slice(decimalIndex + 1) : '';

    if (fraction.length > digits) {
        if (separators.length === 1 && fraction.length === 3 && body[decimalIndex] === groupSeparatorFor(locale)) {
            decimalIndex = -1;
            fraction = '';
        } else {
            const trimmed = fraction.replace(/0+$/, '');
            if (trimmed.length > digits) return null;
            fraction = trimmed;
        }
    }

    const whole = (decimalIndex >= 0 ? body.slice(0, decimalIndex) : body).replace(/[.,]/g, '') || '0';
    // Concatenation, not multiplication: shifting the point is a string operation here.
    const value = Number(whole + fraction.padEnd(digits, '0'));
    if (!Number.isSafeInteger(value)) return null;

    return negative ? -value : value;
}

/**
 * The digits a text input should hold for one amount, for seeding an edit form.
 *
 * <p>Deliberately locale-free and unformatted - `"1234.50"`, never `"1'234.50"` - so what comes out
 * of an untouched form round-trips back through {@link parseMinor} to the byte-identical integer it
 * started as.</p>
 */
export function minorToInputString(amountMinor: number, currency: string): string {
    const digits = minorUnitDigits(currency);
    const negative = amountMinor < 0;
    const raw = String(Math.abs(Math.trunc(amountMinor))).padStart(digits + 1, '0');
    const whole = raw.slice(0, raw.length - digits);
    const fraction = digits > 0 ? `.${raw.slice(raw.length - digits)}` : '';
    return `${negative ? '-' : ''}${whole}${fraction}`;
}

// ── Internals ───────────────────────────────────────────────────────────────

function currencyFormatter(currency: string, digits: number, locale?: string): Intl.NumberFormat | null {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: (currency ?? '').trim().toUpperCase(),
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        });
    } catch {
        return null;
    }
}

/**
 * Rebuilds a formatted `±1` with the real digits substituted in.
 *
 * <p>`±1` has exactly one `integer` part and no `group` parts, which is the whole point of using it
 * as the template: there is no ambiguity about which part to replace. Grouping is already baked
 * into `grouped`, so any `group` part the template did carry is dropped rather than duplicated.</p>
 */
function assemble(parts: Intl.NumberFormatPart[], grouped: string, fraction: string): string {
    let out = '';
    for (const part of parts) {
        if (part.type === 'integer') out += grouped;
        else if (part.type === 'fraction') out += fraction;
        else if (part.type === 'group') continue;
        else out += part.value;
    }
    return out;
}

function groupSeparatorFor(locale?: string): string | null {
    const key = locale ?? '';
    const cached = groupSeparatorByLocale.get(key);
    if (cached !== undefined) return cached;

    const separator = new Intl.NumberFormat(locale, {useGrouping: true})
        .formatToParts(1234567).find(p => p.type === 'group')?.value ?? null;
    groupSeparatorByLocale.set(key, separator);
    return separator;
}
