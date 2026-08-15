/**
 * The promotional-credit wire shapes, from `Echo/Billing.Application/Credit/CreditDtos.cs` and
 * `docs/specs/monetization.md` section 8.
 *
 * <p><b>A balance is points, not money, and there is no currency field on it.</b> Section 8.2 chose
 * abstract points over a currency-denominated wallet so that a multi-currency instance never has to
 * pick one, and so the thing reads as a promotional token rather than as stored value. A SKU carries
 * a cash price beside its point price for exactly one reason - so nobody has to guess what a credit
 * is worth - and the peg between the two is internal and deliberately absent from this file.</p>
 *
 * <p><b>Credit is issued, never sold.</b> Section 8.1 rules out buying, gifting, transferring,
 * refunding and cashing out, and the server has no route for any of them. There is nothing to model
 * here for those, and a control that looked like one would be the first thing to invite the
 * regulatory framing the points denomination exists to avoid.</p>
 *
 * <p>Timestamps are ISO 8601 strings, left unparsed for the same reason the billing DTOs are: the
 * only thing this client does with them is format them.</p>
 */

import {BillingSubjectKind} from './billing.dto';

/**
 * What one ledger line did, as the server's own enum name.
 *
 * <p><b>PascalCase.</b> Unlike `subjectKind` on the checkout DTOs, which carries an explicit
 * lowercasing converter, this rides the service-wide `JsonStringEnumConverter` and arrives as
 * `"Issue"`, `"Spend"`, `"Expiry"`, `"Reversal"` or `"Adjustment"`. Open, because the set can grow
 * and nothing here should crash on a kind added after this build shipped.</p>
 *
 * <p>Almost nothing needs it: every entry already carries a rendered {@link CreditEntryDto.summary},
 * and the kind is here so a line can be given a direction and an icon without parsing that
 * sentence.</p>
 */
export type CreditEntryKind =
    | 'Issue'
    | 'Spend'
    | 'Expiry'
    | 'Reversal'
    | 'Adjustment'
    | (string & {});

/**
 * One parcel of credit and the date it lapses.
 *
 * <p>Lots exist because a single balance number cannot say which part of it is about to expire.
 * Spending consumes the earliest-expiring lot first, so the lot nearest its date is the one a
 * reader has to act on.</p>
 */
export interface CreditLotDto {
    lotId: string;
    /** What is left of this lot. Zero-remainder lots are not sent. */
    points: number;
    /** What it held when it was issued, so a partly spent lot reads as one. */
    originalPoints: number;
    expiresAt: string;
    campaignId: string | null;
}

/**
 * The caller's wallet.
 *
 * <p>`capPoints` is sent rather than hidden because somebody sitting at the cap who does not know it
 * will read the next refused campaign as a bug.</p>
 */
export interface CreditWalletDto {
    userId: string;
    balance: number;
    capPoints: number;
    lots: CreditLotDto[];
    /** The legal sentence, in English. See {@link CreditWalletDto.disclaimerKey}. */
    disclaimer: string;
    /**
     * A stable key for the same sentence, so a client can translate it.
     *
     * <p>Both are sent, and the rule is to prefer the key <b>only when it resolves</b>: a disclaimer
     * reworded on the server ships a new key, and a client that trusted the key blindly would render
     * `credit.disclaimer.v2` to a customer in place of a legal notice.</p>
     */
    disclaimerKey: string;
    cachedAt?: string | null;
}

/**
 * One ledger line, already written out as a sentence by the server.
 *
 * <p>`summary` is rendered rather than composed here. Section 8.8 asks for the ledger in plain
 * language, and three clients each building their own sentence out of `kind` and `amount` would
 * drift the moment one of them forgot a kind.</p>
 */
export interface CreditEntryDto {
    id: string;
    /** Signed: positive for credit arriving, negative for credit leaving. */
    amount: number;
    kind: CreditEntryKind;
    summary: string;
    lotId: string | null;
    campaignId: string | null;
    grantId: string | null;
    reason: string | null;
    /** A staff id on a hand-issued entry. Never rendered to the person who owns the wallet. */
    createdBy: string | null;
    createdAt: string;
}

/** The ledger, newest first, with the balance it adds up to. */
export interface CreditLedgerDto {
    userId: string;
    balance: number;
    entries: CreditEntryDto[];
    disclaimer: string;
    disclaimerKey: string;
}

/**
 * One thing credit buys, priced in points and in cash.
 *
 * <p><b>Nothing here is filtered client-side.</b> A SKU whose plan has no cash price is withheld by
 * the server - section 8.1 forbids credit being the only route to anything - so `cashPriceMinorUnits`
 * is null only on a response from a service that predates that rule, and a screen that re-applied
 * the filter would be maintaining a second copy of a decision the server already made.</p>
 *
 * <p>`subject` is <b>PascalCase</b> here (`"Guild"`, `"User"`), unlike the lowercase kinds on the
 * checkout DTOs: the credit endpoints emit `SubjectKind` through the ordinary enum converter.
 * Compare it with `sameSubjectKind`, never with `===`.</p>
 */
export interface CreditSkuDto {
    code: string;
    title: string;
    description: string | null;
    pricePoints: number;
    cashPriceMinorUnits: number | null;
    cashCurrency: string | null;
    /** The plan this grants. The lookup key, not copy - `title` is the copy. */
    plan: string;
    durationDays: number;
    subject: BillingSubjectKind;
}

/** What the balance can buy, with the balance beside it so one call answers both. */
export interface CreditCatalogueDto {
    balance: number;
    skus: CreditSkuDto[];
    disclaimer: string;
    disclaimerKey: string;
}

/**
 * What a purchase produced.
 *
 * <p><b>`startsAt` is the field that must be rendered.</b> Time purchases queue rather than overlap:
 * thirty days of Pro bought on a guild that is Pro until the 30th starts on the 30th. A screen that
 * implied the purchase took effect now would produce the "I spent my credit and got nothing" ticket
 * by a different route - which is the outcome the queueing rule exists to prevent.</p>
 */
export interface CreditPurchaseDto {
    skuCode: string;
    grantId: string;
    subjectKind: BillingSubjectKind;
    subjectId: string;
    /** Points deducted. Zero is impossible; a purchasable SKU costs more than nothing. */
    spent: number;
    balanceAfter: number;
    startsAt: string;
    /** Null for a grant with no end date, which a credit purchase never produces today. */
    expiresAt: string | null;
    wasQueued: boolean;
}

/**
 * A credit refusal.
 *
 * <p><b>Not `problem+json`.</b> The credit endpoints answer a refusal with a plain 400 carrying
 * `{code, message}`, where the rest of Billing answers with a problem document carrying
 * `{code, detail}`. `message` is written for the person who pressed the button - it names what was
 * refused and, for the permanent-grant case, says that nothing was charged - so it is shown verbatim
 * rather than mapped to a sentence of ours that would have to guess at the same facts.</p>
 */
export interface CreditErrorDto {
    code: string;
    message: string;
}
