import {CreditLotDto, CreditPurchaseDto} from '../dtos/response/credit.dto';
import {describeCreditError} from '../services/credit.service';
import {formatBillingDate} from './subscription-copy';

/** Every table here must use literal keys; `i18n-keys.spec.ts` cannot see a computed one. */

/** How close to its date a lot has to be before it is called out. */
export const CREDIT_EXPIRY_WARNING_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Our own disclaimer, for when the server sends none. A balance must never render without one. */
export const CREDIT_DISCLAIMER_FALLBACK_KEY = 'BILLING.CREDIT.DISCLAIMER';

/** A refusal this build has no better sentence for, and every failure that is not JSON. */
export const CREDIT_GENERIC_ERROR_KEY = 'BILLING.CREDIT.ERROR.GENERIC';

const PURCHASE_KEYS = {
    activeTitle: 'BILLING.CREDIT.PURCHASE.ACTIVE_TITLE',
    activeBody: 'BILLING.CREDIT.PURCHASE.ACTIVE_BODY',
    activeBodyNoEnd: 'BILLING.CREDIT.PURCHASE.ACTIVE_BODY_NO_END',
    queuedTitle: 'BILLING.CREDIT.PURCHASE.QUEUED_TITLE',
    queuedTitleUndated: 'BILLING.CREDIT.PURCHASE.QUEUED_TITLE_UNDATED',
    queuedBody: 'BILLING.CREDIT.PURCHASE.QUEUED_BODY',
    queuedBodyNoEnd: 'BILLING.CREDIT.PURCHASE.QUEUED_BODY_NO_END',
    queuedBodyUndated: 'BILLING.CREDIT.PURCHASE.QUEUED_BODY_UNDATED',
} as const;

/** For the spec that proves every key this file can produce resolves in en.json. */
export const CREDIT_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(PURCHASE_KEYS),
    CREDIT_DISCLAIMER_FALLBACK_KEY,
    CREDIT_GENERIC_ERROR_KEY,
];

/**
 * The disclaimer that has to sit next to every balance. Exactly one of key or text comes back.
 * The server's key is preferred only when it resolves in the active locale.
 *
 * @param text the server's English sentence.
 * @param key the server's stable key for the same sentence.
 * @param resolves whether this client's active locale has a string under a key.
 */
export function creditDisclaimerCopy(
    text: string | null | undefined,
    key: string | null | undefined,
    resolves: (key: string) => boolean,
): {key: string | null; text: string | null} {
    const trimmedKey = (key ?? '').trim();
    if (trimmedKey.length > 0 && resolves(trimmedKey)) return {key: trimmedKey, text: null};

    const trimmedText = (text ?? '').trim();
    if (trimmedText.length > 0) return {key: null, text: trimmedText};

    return {key: CREDIT_DISCLAIMER_FALLBACK_KEY, text: null};
}

/** One lot as the wallet renders it: what is left, when it goes, and whether that is soon. */
export interface CreditLotCopy {
    lot: CreditLotDto;
    /** Null when `expiresAt` is not a date this client can read. */
    expires: string | null;
    /** Whole days until the date, negative once it has passed. Null when there is no date. */
    daysLeft: number | null;
    /** Inside {@link CREDIT_EXPIRY_WARNING_DAYS}, so the row is called out rather than listed. */
    expiringSoon: boolean;
    /** True where the lot has been spent down from what it was issued with. */
    partlySpent: boolean;
}

/** The lots, soonest to lapse first. A lot with an unreadable date sorts last. */
export function creditLotCopy(
    lots: readonly CreditLotDto[] | null | undefined,
    now: Date = new Date(),
    locale?: string,
): CreditLotCopy[] {
    return (lots ?? [])
        .map(lot => {
            const daysLeft = wholeDaysUntil(lot.expiresAt, now);
            return {
                lot,
                expires: formatBillingDate(lot.expiresAt, 'long', locale),
                daysLeft,
                expiringSoon: daysLeft !== null && daysLeft <= CREDIT_EXPIRY_WARNING_DAYS,
                partlySpent: lot.points < lot.originalPoints,
            };
        })
        .sort(
            (left, right) =>
                (left.daysLeft ?? Number.MAX_SAFE_INTEGER) - (right.daysLeft ?? Number.MAX_SAFE_INTEGER),
        );
}

/** What a completed purchase says, which is above all when it starts. */
export interface CreditPurchaseCopy {
    /** A sentence key taking `{title}` and, on the dated queued path, `{date}`. */
    titleKey: string;
    /** A sentence key taking `{date}` and `{until}`. */
    bodyKey: string;
    /** The formatted start, or null when the server sent one this client cannot read. */
    startsOn: string | null;
    endsOn: string | null;
    queued: boolean;
}

/** How to describe what the credit just bought. A queued purchase never uses the active wording. */
export function creditPurchaseCopy(purchase: CreditPurchaseDto, locale?: string): CreditPurchaseCopy {
    const startsOn = formatBillingDate(purchase.startsAt, 'long', locale);
    const endsOn = formatBillingDate(purchase.expiresAt, 'long', locale);

    if (!purchase.wasQueued) {
        return {
            titleKey: PURCHASE_KEYS.activeTitle,
            bodyKey: endsOn ? PURCHASE_KEYS.activeBody : PURCHASE_KEYS.activeBodyNoEnd,
            startsOn,
            endsOn,
            queued: false,
        };
    }

    if (startsOn === null) {
        return {
            titleKey: PURCHASE_KEYS.queuedTitleUndated,
            bodyKey: PURCHASE_KEYS.queuedBodyUndated,
            startsOn: null,
            endsOn,
            queued: true,
        };
    }

    return {
        titleKey: PURCHASE_KEYS.queuedTitle,
        bodyKey: endsOn ? PURCHASE_KEYS.queuedBody : PURCHASE_KEYS.queuedBodyNoEnd,
        startsOn,
        endsOn,
        queued: true,
    };
}

/** One refusal, as either the server's own sentence or a generic one of ours. */
export interface CreditErrorCopy {
    /** Null when {@link text} carries the sentence instead. */
    key: string | null;
    /** The server's sentence, rendered verbatim. Never a code and never a status. */
    text: string | null;
}

/** The sentence for a refused credit operation. The server's `message` wins wherever there is one. */
export function creditErrorCopy(err: unknown): CreditErrorCopy {
    const failure = describeCreditError(err);
    if (failure?.message) return {key: null, text: failure.message};

    return {key: CREDIT_GENERIC_ERROR_KEY, text: null};
}

/** A fresh idempotency key. Call once per dialog, never per press. */
export function newIdempotencyKey(): string {
    return crypto.randomUUID();
}

/** Whole days from now until an instant, floored, or null when it is not one. */
function wholeDaysUntil(iso: string | null | undefined, now: Date): number | null {
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;

    return Math.floor((at.getTime() - now.getTime()) / MS_PER_DAY);
}
