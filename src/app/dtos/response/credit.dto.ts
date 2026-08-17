/**
 * The promotional-credit wire shapes, from `docs/specs/monetization.md` section 8. A balance is
 * points, not money, and carries no currency. Timestamps are ISO 8601 strings.
 */

import {BillingSubjectKind} from './billing.dto';

/** What one ledger line did, as the server's own enum name. PascalCase on the wire, and open. */
export type CreditEntryKind = 'Issue' | 'Spend' | 'Expiry' | 'Reversal' | 'Adjustment' | (string & {});

/** One parcel of credit and the date it lapses. Spending consumes the earliest-expiring lot first. */
export interface CreditLotDto {
    lotId: string;
    /** What is left of this lot. Zero-remainder lots are not sent. */
    points: number;
    /** What it held when it was issued, so a partly spent lot reads as one. */
    originalPoints: number;
    expiresAt: string;
    campaignId: string | null;
}

/** The caller's wallet. */
export interface CreditWalletDto {
    userId: string;
    balance: number;
    capPoints: number;
    lots: CreditLotDto[];
    /** The legal sentence, in English. See {@link CreditWalletDto.disclaimerKey}. */
    disclaimer: string;
    /** A stable key for the same sentence. Prefer it only when it resolves; otherwise show `disclaimer`. */
    disclaimerKey: string;
    cachedAt?: string | null;
}

/** One ledger line, already written out as a sentence by the server. Render `summary`, never compose it. */
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
 * One thing credit buys, priced in points and in cash. Nothing here is filtered client-side.
 * `subject` is PascalCase here, so compare it with `sameSubjectKind`, never with `===`.
 */
export interface CreditSkuDto {
    code: string;
    title: string;
    description: string | null;
    pricePoints: number;
    cashPriceMinorUnits: number | null;
    cashCurrency: string | null;
    /** The plan this grants. The lookup key, not copy; `title` is the copy. */
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

/** What a purchase produced. Time purchases queue rather than overlap, so `startsAt` must be rendered. */
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

/** A credit refusal: a plain 400 carrying `{code, message}`, not `problem+json`. Show `message` verbatim. */
export interface CreditErrorDto {
    code: string;
    message: string;
}
