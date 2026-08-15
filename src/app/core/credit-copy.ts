import {CreditLotDto, CreditPurchaseDto} from '../dtos/response/credit.dto';
import {describeCreditError} from '../services/credit.service';
import {formatBillingDate} from './subscription-copy';

/**
 * What a credit surface is allowed to say, as literal translation keys.
 *
 * <p>Same argument as `billing-copy.ts` and `subscription-copy.ts`: `'BILLING.CREDIT.' + something`
 * is the obvious spelling and is exactly what `i18n-keys.spec.ts` cannot see, so a renamed key would
 * render raw to a customer with every test in this repo green. Tables of literals, exported for a
 * spec to walk.</p>
 */

/**
 * How close to its date a lot has to be before it is called out.
 *
 * <p>Thirty days, which is what section 8.5 recommends for the expiry notification and what the
 * admin console's own wallet view already uses. One threshold across the two surfaces, because a
 * lot flagged for staff and not for the person who owns it is a support conversation that starts
 * with the two of them looking at different screens.</p>
 */
export const CREDIT_EXPIRY_WARNING_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Our own copy of the section 8.1 sentence, for the one case the server sends nothing usable.
 *
 * <p>It has to say something. "No cash value, not refundable, not transferable, and it expires" is
 * required wherever a balance is displayed, so an empty payload cannot be allowed to drop it.</p>
 */
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
 * The sentence that has to sit next to every balance, and which of the two forms to render it in.
 *
 * <p>The server sends the disclaimer twice - as English text and as a stable key - so that a client
 * can translate it without the two ever being able to disagree about what it says. Exactly one of
 * the two comes back from here.</p>
 *
 * <p><b>The key is preferred only when it resolves.</b> Rewording the disclaimer ships a new key,
 * and a client that trusted the key blindly would put `credit.disclaimer.v2` in front of a customer
 * where a legal notice belongs. The server's own text is the fallback, and our own sentence is the
 * fallback for that, because the one outcome section 8.1 does not allow is a balance with no
 * disclaimer beside it.</p>
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

/**
 * The lots, soonest to lapse first.
 *
 * <p>Sorted by date rather than left in server order because that is the order they will be spent
 * in - the ledger consumes the earliest-expiring lot first - so the top row is always the one a
 * decision is about. A lot with an unreadable date sorts last: it cannot be reasoned about, and
 * putting it first would push the urgent one off the top of the list.</p>
 */
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
        .sort((left, right) => (left.daysLeft ?? Number.MAX_SAFE_INTEGER)
            - (right.daysLeft ?? Number.MAX_SAFE_INTEGER));
}

/** What a completed purchase says, which is above all <b>when it starts</b>. */
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

/**
 * How to describe what the credit just bought.
 *
 * <p><b>A queued purchase never falls back to the immediate wording.</b> Bought time queues behind
 * what the subject already holds, so thirty days of Pro on a guild that is Pro until the 30th starts
 * on the 30th - and a screen that said "active" would produce the "I spent my credit and got
 * nothing" ticket the queueing rule exists to prevent. Where `wasQueued` is true and the date cannot
 * be read, the copy still says it starts later; it simply does not name the day.</p>
 */
export function creditPurchaseCopy(
    purchase: CreditPurchaseDto,
    locale?: string,
): CreditPurchaseCopy {
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

/**
 * The sentence for a refused credit operation.
 *
 * <p><b>The server's `message` wins wherever there is one.</b> These refusals are written for the
 * person who pressed the button and carry facts a table on this side could not: which plan is
 * already held permanently, and - the one that matters most - that nothing was charged. Replacing
 * that with a sentence of ours would either lose the reassurance or invent it.</p>
 */
export function creditErrorCopy(err: unknown): CreditErrorCopy {
    const failure = describeCreditError(err);
    if (failure?.message) return {key: null, text: failure.message};

    return {key: CREDIT_GENERIC_ERROR_KEY, text: null};
}

/**
 * A fresh idempotency key.
 *
 * <p>Called <b>once per dialog</b> and never per press. The whole value of the key is that the
 * retry after a dropped connection replays the first purchase instead of making a second one, and a
 * key regenerated on submit throws that away while looking exactly as correct.</p>
 */
export function newIdempotencyKey(): string {
    return crypto.randomUUID();
}

/**
 * Whole days from now until an instant, or null when it is not one.
 *
 * <p>Floored rather than rounded, so a lot lapsing in twenty-three hours reads as zero days left
 * rather than as one. The rounding direction is the difference between warning somebody in time and
 * warning them the day after.</p>
 */
function wholeDaysUntil(iso: string | null | undefined, now: Date): number | null {
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;

    return Math.floor((at.getTime() - now.getTime()) / MS_PER_DAY);
}
