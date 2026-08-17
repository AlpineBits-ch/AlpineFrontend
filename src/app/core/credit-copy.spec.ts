import {HttpErrorResponse} from '@angular/common/http';
import {describe, expect, it} from 'vitest';
import en from '../../assets/i18n/locales/en.json';
import {CreditLotDto, CreditPurchaseDto} from '../dtos/response/credit.dto';
import {
    CREDIT_DISCLAIMER_FALLBACK_KEY,
    CREDIT_EXPIRY_WARNING_DAYS,
    CREDIT_GENERIC_ERROR_KEY,
    CREDIT_TRANSLATION_KEYS,
    creditDisclaimerCopy,
    creditErrorCopy,
    creditLotCopy,
    creditPurchaseCopy,
    newIdempotencyKey,
} from './credit-copy';

const NOW = new Date('2026-08-15T12:00:00Z');

function daysFromNow(days: number): string {
    return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function lot(over: Partial<CreditLotDto> = {}): CreditLotDto {
    return {
        lotId: 'lot_1',
        points: 500,
        originalPoints: 500,
        expiresAt: daysFromNow(200),
        campaignId: null,
        ...over,
    };
}

function purchase(over: Partial<CreditPurchaseDto> = {}): CreditPurchaseDto {
    return {
        skuCode: 'guild_pro_30d',
        grantId: 'grant_1',
        subjectKind: 'Guild',
        subjectId: 'gld_1',
        spent: 900,
        balanceAfter: 100,
        startsAt: '2026-08-15T12:00:00Z',
        expiresAt: '2026-09-14T12:00:00Z',
        wasQueued: false,
        ...over,
    };
}

describe('the disclaimer that has to sit next to a balance', () => {
    it('prefers the server key where this build has the string', () => {
        const copy = creditDisclaimerCopy('English sentence', 'credit.disclaimer', () => true);

        expect(copy.key).toBe('credit.disclaimer');
        expect(copy.text).toBeNull();
    });

    /**
     * The case that stops a legal notice being replaced by a placeholder. Rewording the disclaimer
     * on the server ships a new key, and a client that trusted the key blindly would put
     * "credit.disclaimer.v2" in front of a customer.
     */
    it('renders the server sentence for a key this build has never seen', () => {
        const copy = creditDisclaimerCopy('Credits have no cash value.', 'credit.disclaimer.v2', () => false);

        expect(copy.key).toBeNull();
        expect(copy.text).toBe('Credits have no cash value.');
    });

    it('falls back to its own sentence rather than showing a balance with nothing beside it', () => {
        expect(creditDisclaimerCopy('', '', () => false).key).toBe(CREDIT_DISCLAIMER_FALLBACK_KEY);
        expect(creditDisclaimerCopy(null, null, () => false).key).toBe(CREDIT_DISCLAIMER_FALLBACK_KEY);
        expect(creditDisclaimerCopy(undefined, '   ', () => true).key).toBe(CREDIT_DISCLAIMER_FALLBACK_KEY);
    });
});

describe('the lots and their dates', () => {
    it('reports what is left, when it goes and whether the lot was partly spent', () => {
        const [row] = creditLotCopy([lot({points: 300, originalPoints: 500})], NOW, 'en-GB');

        expect(row.lot.points).toBe(300);
        expect(row.partlySpent).toBe(true);
        expect(row.expires).toContain('2027');
        expect(row.expiringSoon).toBe(false);
    });

    /** Thirty days, the same threshold the console uses. A lot inside it is a decision to make. */
    it('marks a lot inside the warning window and leaves one outside it alone', () => {
        const rows = creditLotCopy(
            [
                lot({lotId: 'far', expiresAt: daysFromNow(CREDIT_EXPIRY_WARNING_DAYS + 1)}),
                lot({lotId: 'near', expiresAt: daysFromNow(CREDIT_EXPIRY_WARNING_DAYS - 1)}),
            ],
            NOW,
        );

        const near = rows.find(row => row.lot.lotId === 'near');
        const far = rows.find(row => row.lot.lotId === 'far');

        expect(near?.expiringSoon).toBe(true);
        expect(far?.expiringSoon).toBe(false);
    });

    /** The boundary itself is inside the window: a lot lapsing on day thirty is not a safe lot. */
    it('counts the threshold day itself as expiring soon', () => {
        const [row] = creditLotCopy([lot({expiresAt: daysFromNow(CREDIT_EXPIRY_WARNING_DAYS)})], NOW);

        expect(row.expiringSoon).toBe(true);
    });

    /** Spending consumes the earliest-expiring lot first, so that is the order they are read in. */
    it('puts the lot nearest its date at the top', () => {
        const rows = creditLotCopy(
            [
                lot({lotId: 'later', expiresAt: daysFromNow(100)}),
                lot({lotId: 'sooner', expiresAt: daysFromNow(5)}),
            ],
            NOW,
        );

        expect(rows.map(row => row.lot.lotId)).toEqual(['sooner', 'later']);
    });

    /**
     * A date this client cannot read cannot be reasoned about, and must not be guessed at as
     * urgent - nor allowed to push the genuinely urgent row off the top of the list.
     */
    it('neither warns about nor promotes a lot whose date is not one', () => {
        const rows = creditLotCopy(
            [
                lot({lotId: 'broken', expiresAt: 'not a timestamp'}),
                lot({lotId: 'near', expiresAt: daysFromNow(2)}),
            ],
            NOW,
        );

        expect(rows.map(row => row.lot.lotId)).toEqual(['near', 'broken']);
        const broken = rows.find(row => row.lot.lotId === 'broken');
        expect(broken?.expires).toBeNull();
        expect(broken?.daysLeft).toBeNull();
        expect(broken?.expiringSoon).toBe(false);
    });

    it('has nothing to say about a wallet with no lots', () => {
        expect(creditLotCopy([], NOW)).toEqual([]);
        expect(creditLotCopy(null, NOW)).toEqual([]);
        expect(creditLotCopy(undefined, NOW)).toEqual([]);
    });
});

describe('what a purchase says it did', () => {
    it('says the thing is active when it started immediately', () => {
        const copy = creditPurchaseCopy(purchase({wasQueued: false}), 'en-GB');

        expect(copy.queued).toBe(false);
        expect(copy.titleKey).toBe('BILLING.CREDIT.PURCHASE.ACTIVE_TITLE');
        expect(copy.bodyKey).toBe('BILLING.CREDIT.PURCHASE.ACTIVE_BODY');
        expect(copy.endsOn).toContain('September');
    });

    /**
     * The whole reason this helper exists. Bought time queues behind what the subject already
     * holds, so a screen that said "active" would be the "I spent my credit and got nothing"
     * complaint arriving by a different route.
     */
    it('names the day a queued purchase starts, and never says it is active', () => {
        const copy = creditPurchaseCopy(
            purchase({
                wasQueued: true,
                startsAt: '2026-09-30T00:00:00Z',
                expiresAt: '2026-10-30T00:00:00Z',
            }),
            'en-GB',
        );

        expect(copy.queued).toBe(true);
        expect(copy.titleKey).toBe('BILLING.CREDIT.PURCHASE.QUEUED_TITLE');
        expect(copy.bodyKey).toBe('BILLING.CREDIT.PURCHASE.QUEUED_BODY');
        expect(copy.startsOn).toBe('30 September 2026');
        expect(copy.titleKey).not.toContain('ACTIVE');
    });

    /** A queued purchase with a date nobody can read still starts later. It just names no day. */
    it('keeps the queued wording when the start date cannot be read', () => {
        const copy = creditPurchaseCopy(purchase({wasQueued: true, startsAt: 'not a timestamp'}));

        expect(copy.titleKey).toBe('BILLING.CREDIT.PURCHASE.QUEUED_TITLE_UNDATED');
        expect(copy.bodyKey).toBe('BILLING.CREDIT.PURCHASE.QUEUED_BODY_UNDATED');
        expect(copy.startsOn).toBeNull();
        expect(copy.queued).toBe(true);
    });

    it('has a sentence for a grant with no end date', () => {
        expect(creditPurchaseCopy(purchase({expiresAt: null})).bodyKey).toBe(
            'BILLING.CREDIT.PURCHASE.ACTIVE_BODY_NO_END',
        );
        expect(creditPurchaseCopy(purchase({wasQueued: true, expiresAt: null})).bodyKey).toBe(
            'BILLING.CREDIT.PURCHASE.QUEUED_BODY_NO_END',
        );
    });
});

describe('a refused spend', () => {
    /**
     * The server's sentence names the plan already held and says nothing was charged. Neither fact
     * is available to a code-to-sentence table on this side, so neither is invented here.
     */
    it('is explained in the service own words', () => {
        const copy = creditErrorCopy(
            new HttpErrorResponse({
                status: 400,
                error: {
                    code: 'already_permanent',
                    message: "Guild gld_1 already holds 'pro' with no end date. Nothing has been charged.",
                },
            }),
        );

        expect(copy.text).toContain('Nothing has been charged.');
        expect(copy.key).toBeNull();
    });

    /** These refusals are plain JSON, not problem+json, so the sentence is under `message`. */
    it('reads a sentence out of a body that arrived as text', () => {
        const copy = creditErrorCopy(
            new HttpErrorResponse({
                status: 400,
                error: JSON.stringify({code: 'insufficient_balance', message: 'Not enough credits.'}),
            }),
        );

        expect(copy.text).toBe('Not enough credits.');
    });

    it('apologises generically for a failure that carried no sentence at all', () => {
        expect(creditErrorCopy(new HttpErrorResponse({status: 500})).key).toBe(CREDIT_GENERIC_ERROR_KEY);
        expect(creditErrorCopy(new Error('offline')).key).toBe(CREDIT_GENERIC_ERROR_KEY);
        expect(creditErrorCopy(null).key).toBe(CREDIT_GENERIC_ERROR_KEY);
    });

    /** Never the code and never the status. "400" is not a sentence. */
    it('renders neither the code nor the status', () => {
        const copy = creditErrorCopy(
            new HttpErrorResponse({
                status: 400,
                error: {code: 'unknown_sku'},
            }),
        );

        expect(copy.text).toBeNull();
        expect(copy.key).toBe(CREDIT_GENERIC_ERROR_KEY);
    });
});

describe('the idempotency key', () => {
    it('is a different key every time it is minted', () => {
        const keys = new Set([newIdempotencyKey(), newIdempotencyKey(), newIdempotencyKey()]);

        expect(keys.size).toBe(3);
    });

    it('is a shape the server will take', () => {
        expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/i);
    });
});

describe('the credit keys', () => {
    /** Held in tables and handed to `translate` as variables, so no other spec can see them. */
    it('all resolve in en.json', () => {
        const strings = en as Record<string, string>;
        const missing = CREDIT_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(CREDIT_TRANSLATION_KEYS.length).toBeGreaterThan(5);
        expect(missing, `keys held in a table but absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /**
     * The server's own key, which is what the wallet renders when it resolves. Lowercase, unlike
     * every other key in this file, because it is `CreditDisclaimer.LocalisationKey` verbatim - and
     * a key that has been "tidied" into the local convention no longer matches what arrives.
     */
    it('includes the server disclaimer key exactly as the server spells it', () => {
        expect(en as Record<string, string>).toHaveProperty('credit.disclaimer');
    });
});
