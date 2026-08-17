import {EntitlementValueDto} from '../dtos/response/entitlement.dto';

/**
 * How one entitlement value reads on a comparison table. Nothing here decides what a value means;
 * a rung renders as the rung the server named.
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

/** The one place a catalogue key's units are known, read off the key's suffix. */
function unitsOf(key: string): 'bytes' | 'days' | 'count' {
    if (key.endsWith('_bytes')) return 'bytes';
    if (key.endsWith('_days')) return 'days';
    return 'count';
}

/** `104857600` -> `"100 MB"`, in binary steps. */
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

/** What to render in one cell of the comparison table. Never an empty cell, and never a false zero. */
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
