/** Money, as whole minor units. Never divide or multiply by 100 here; the decimal point is moved by
 * slicing and padding digit strings, which keeps this file out of floating point entirely. */

/** What most of the world's currencies use, and what an unrecognised code is assumed to be. */
const DEFAULT_MINOR_DIGITS = 2;

/** Characters that only ever separate thousands, never decimals. */
const GROUPING_NOISE = /[\s'\u2019\u00b4]/g;

const digitsByCurrency = new Map<string, number>();
const groupSeparatorByLocale = new Map<string, string | null>();

/** The ISO-4217 exponent for a currency: 2 for CHF and EUR, 0 for JPY, 3 for KWD. */
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

/** `1234, 'CHF'` -> `"CHF 1'234.00"`, in the viewer's locale. */
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

    // Intl would not take the code. Fall back to a plain number with the code in front.
    const plain = new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
    return `${currency} ${assemble(plain.formatToParts(negative ? -1 : 1), grouped, fraction)}`;
}

/**
 * User input -> whole minor units, or `null` when it is not a number this currency can hold.
 * Anything still ambiguous after the separator rules below is rejected, never guessed at.
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

/** The digits a text input should hold for one amount. Locale-free, so it round-trips through
 * {@link parseMinor} unchanged. */
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

/** Rebuilds a formatted `±1` with the real digits substituted in. */
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
