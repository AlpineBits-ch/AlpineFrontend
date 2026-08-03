import {ExpenseSplitKind} from '../response/ledger.dto';

/** What `LedgerEndpoint` refuses, mirrored so the form refuses it first. */
export const LEDGER_LIMITS = {
    /** `MaxDescriptionLength`, checked on both create and update. */
    descriptionMaxLength: 200,
} as const;

/**
 * A three-letter ISO-4217 code, which is the whole of the server's currency rule.
 *
 * <p>`UpdateConfigAsync` upper-cases what it is given and then demands three ASCII letters, so
 * `chf` is accepted and `CHF ` is accepted and `CH1` is a `400`. Doing the same here means the
 * dialog can preview the relabelled amounts rather than round-tripping a rejection.</p>
 */
export function normalizeCurrencyCode(input: string): string | null {
    const code = input.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * What the client is allowed to say about a split, which is deliberately less than the server
 * knows.
 *
 * <p>`shareValue` is a weight under `Shares`, and is left off entirely under `Equal`. There is no
 * field here for a per-person `amountMinor`, and that is the point: the server distributes
 * remainders on its own rules - 1000 across three is 334/333/333 - and a client that worked the
 * amounts out itself would eventually name a different flatmate for the odd rappen and be rejected
 * for a total that no longer adds up.</p>
 */
export interface ExpenseShareDto {
    userId: string;
    shareValue?: number;
}

export interface CreateExpenseDto {
    description: string;
    /**
     * Whole minor units of the channel's currency. **Never a decimal** - `12.34` francs is `1234`.
     * See `src/app/helpers/money.helper.ts`.
     */
    amountMinor: number;
    /** Omitted means the caller. Naming anyone else needs `ManageLedger`. */
    payerUserId?: string;
    occurredAt?: string;
    splitKind: ExpenseSplitKind;
    /**
     * **Empty (or omitted) under `Equal` means everyone in the guild** - the common case, and the
     * only spelling that stays correct when a flatmate moves in.
     */
    shares?: ExpenseShareDto[];
}

/** Only the fields sent are touched; omitting one leaves it unchanged. */
export type UpdateExpenseDto = Partial<CreateExpenseDto>;

/**
 * Records that a payment already happened. It moves no money - there is none here to move - it
 * tells the ledger the debt was cleared outside it.
 *
 * <p>The server calls this `CreateSettlementDto`; the field set is its, verbatim. Recording one
 * where `fromUserId` is <b>not</b> the caller needs `ManageLedger` - note that being the
 * *recipient* does not soften that, so "Marco paid me" is a third-party write when Marco types it
 * and a third-party write when you do.</p>
 */
export interface RecordSettlementDto {
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
    settledAt?: string;
}

export interface UpdateLedgerConfigDto {
    /** ISO-4217. Existing amounts keep their digits and are simply relabelled. */
    currency: string;
}
