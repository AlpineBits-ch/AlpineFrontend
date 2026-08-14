import {EntitlementValueDto} from '../dtos/response/entitlement.dto';

/**
 * How one entitlement value reads on a comparison table.
 *
 * <p>The catalogue publishes plan entitlements in the <b>same</b> encoding the entitlement snapshot
 * uses, which is the reason this file exists once rather than twice: the numbers a plan promises and
 * the numbers a subject currently resolves are the same three shapes, and a second renderer would
 * agree with the first on "75" and disagree on the two that matter - the unlimited ceiling that
 * arrives as `value: null`, and a key whose value came back in a shape it never declares.</p>
 *
 * <p>Nothing here decides what a value <i>means</i>. A rung is rendered as the rung the server
 * named, not as a resolution this file invented a mapping for: that mapping is a pricing decision
 * and one made in a `.ts` file is one nobody can change later.</p>
 */

/** Every sentence a value can render as, as literal keys. Computed keys render raw to a user. */
export const ENTITLEMENT_VALUE_KEYS = {
    unlimited: 'BILLING.VALUE.UNLIMITED',
    count: 'BILLING.VALUE.COUNT',
    size: 'BILLING.VALUE.SIZE',
    days: 'BILLING.VALUE.DAYS',
    included: 'BILLING.VALUE.INCLUDED',
    notIncluded: 'BILLING.VALUE.NOT_INCLUDED',
    rung: 'BILLING.VALUE.RUNG',
    /** A shape this build cannot read. Never a blank cell, which reads as "not included". */
    unknown: 'BILLING.VALUE.UNKNOWN',
    /** The key is not on this plan's list at all, which is a different fact from "off". */
    absent: 'BILLING.VALUE.ABSENT',
} as const;

/** For the spec that proves every key above resolves in en.json. */
export const ENTITLEMENT_VALUE_TRANSLATION_KEYS: readonly string[] =
    Object.values(ENTITLEMENT_VALUE_KEYS);

export interface EntitlementValueCopy {
    key: string;
    /** Interpolation for the key. Empty for the keys that take none. */
    params: Record<string, string>;
}

/**
 * The one place a catalogue key's units are known.
 *
 * <p>Read off the key's suffix rather than an enumerated table, because the catalogue grows: a
 * `storage.archive_quota_bytes` added next quarter renders as a size in a build that predates it,
 * where a table would render it as a nine-digit count.</p>
 */
function unitsOf(key: string): 'bytes' | 'days' | 'count' {
    if (key.endsWith('_bytes')) return 'bytes';
    if (key.endsWith('_days')) return 'days';
    return 'count';
}

/**
 * `104857600` -> `"100 MB"`.
 *
 * <p>Binary steps, because every ceiling this renders is a byte count the server compares against
 * with `>=` on a whole number of bytes. One fractional digit below ten so that 1.5 GB does not read
 * as "2 GB" next to a plan that really does grant two.</p>
 */
function formatBytes(bytes: number, locale?: string): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = Math.abs(bytes);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    const digits = index > 0 && value < 10 && !Number.isInteger(value) ? 1 : 0;
    const rendered = new Intl.NumberFormat(locale, {maximumFractionDigits: digits}).format(value);
    return `${bytes < 0 ? '-' : ''}${rendered} ${units[index]}`;
}

/**
 * What to render in one cell of the comparison table.
 *
 * <p>`undefined` is {@link ENTITLEMENT_VALUE_KEYS.absent} and never an empty cell: "this plan does
 * not list this key" and "this plan lists it as off" are different facts, and a blank cell says the
 * second one about the first.</p>
 *
 * <p>A numeric value that is neither unlimited nor a number is `unknown` rather than zero. Zero is a
 * real ceiling that means "none of this", and rendering it for a payload this build could not read
 * would understate a plan somebody is being asked to pay for.</p>
 */
export function entitlementValueCopy(
    key: string,
    value: EntitlementValueDto | undefined,
    locale?: string,
): EntitlementValueCopy {
    if (!value) return {key: ENTITLEMENT_VALUE_KEYS.absent, params: {}};

    switch (value.kind) {
        case 'numeric': {
            if (value.unlimited) return {key: ENTITLEMENT_VALUE_KEYS.unlimited, params: {}};
            if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
                return {key: ENTITLEMENT_VALUE_KEYS.unknown, params: {}};
            }
            const units = unitsOf(key);
            if (units === 'bytes') {
                return {
                    key: ENTITLEMENT_VALUE_KEYS.size,
                    params: {size: formatBytes(value.value, locale)},
                };
            }
            const amount = new Intl.NumberFormat(locale).format(value.value);
            return units === 'days'
                ? {key: ENTITLEMENT_VALUE_KEYS.days, params: {count: amount}}
                : {key: ENTITLEMENT_VALUE_KEYS.count, params: {count: amount}};
        }
        case 'flag':
            return {
                key: value.granted
                    ? ENTITLEMENT_VALUE_KEYS.included
                    : ENTITLEMENT_VALUE_KEYS.notIncluded,
                params: {},
            };
        case 'ladder':
            return {key: ENTITLEMENT_VALUE_KEYS.rung, params: {rung: value.rung}};
        default:
            return {key: ENTITLEMENT_VALUE_KEYS.unknown, params: {}};
    }
}
