import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {PurchaseCreditRequest} from '../dtos/request/credit.dto';
import {
    CreditCatalogueDto,
    CreditLedgerDto,
    CreditPurchaseDto,
    CreditWalletDto,
} from '../dtos/response/credit.dto';

/**
 * The refusals the credit endpoints name, from `CreditErrorCodes` and `CreditPurchaseErrorCodes`.
 *
 * <p>Open at the type level like every other refusal vocabulary here. Only two of these are worth
 * branching on in the client; the rest are shown through the server's own `message`, which says more
 * than a code-to-sentence table could.</p>
 */
export const CREDIT_ERROR_CODES = {
    /** 400. The SKU is not on this instance's catalogue. */
    unknownSku: 'unknown_sku',
    /** 400. The SKU's plan has no cash price, so credit must not be the only route to it. */
    noCashPrice: 'no_cash_price',
    /** 400. A guild SKU with no guild named. */
    targetRequired: 'target_required',
    /**
     * 400. The subject already holds this plan with no end date, so bought time would queue behind
     * something that never finishes. Refused outright, and <b>nothing is charged</b>.
     */
    alreadyPermanent: 'already_permanent',
    /** 400. The wallet does not hold enough points. */
    insufficientBalance: 'insufficient_balance',
} as const;

export type CreditErrorCode =
    | typeof CREDIT_ERROR_CODES[keyof typeof CREDIT_ERROR_CODES]
    | (string & {});

/**
 * A credit refusal, read out of the plain `{code, message}` body these endpoints send.
 *
 * <p>Deliberately not `describeBillingError`. That one reads `detail` out of a `problem+json`
 * document, which is what the checkout endpoints answer with; the credit endpoints answer a refusal
 * with `Results.BadRequest(new CreditErrorDto(...))`, so the sentence is under `message` and
 * `detail` is absent. Reusing the billing reader here would find the code and silently lose every
 * sentence the server wrote - including the one that says nothing was charged.</p>
 */
export interface CreditFailure {
    /** Null when the body carried no code, which includes every response that is not JSON. */
    code: CreditErrorCode | null;
    status: number;
    /** The server's own sentence for this refusal. Customer-worded, and shown verbatim. */
    message: string | null;
    cause: HttpErrorResponse;
}

/**
 * Reads a credit refusal, or null when this is not an HTTP error at all.
 *
 * <p>`detail` is accepted alongside `message` so a refusal that ever starts arriving as a problem
 * document still yields its sentence rather than falling back to a generic apology.</p>
 */
export function describeCreditError(err: unknown): CreditFailure | null {
    if (!(err instanceof HttpErrorResponse)) return null;

    const body = jsonBody(err.error);
    return {
        code: firstString(body?.code, body?.extensions?.code),
        status: err.status,
        message: firstString(body?.message, body?.detail),
        cause: err,
    };
}

/**
 * Whether this failure is the instance saying credit does not exist here.
 *
 * <p>A 404 is the answer on a self-hosted instance - where everything already resolves to its
 * maximum and a wallet is meaningless - and on a hosted one that never deployed Billing. It is the
 * one failure that must hide the surface rather than apologise on it: a zero balance and "credit is
 * not available here" are different statements, and the wrong one gets reported as a defect.</p>
 */
export function creditIsAbsent(err: unknown): boolean {
    return err instanceof HttpErrorResponse && err.status === 404;
}

interface JsonBody {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
    extensions?: {code?: unknown};
}

function jsonBody(raw: unknown): JsonBody | null {
    if (typeof raw === 'string') {
        try {
            return jsonBody(JSON.parse(raw));
        } catch {
            return null;
        }
    }
    return raw && typeof raw === 'object' ? raw as JsonBody : null;
}

function firstString(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return null;
}

/**
 * The four caller-scoped credit routes (monetization.md section 8.8).
 *
 * <p><b>Every one of them is about the caller and nothing else.</b> The user id comes off the token
 * and is never a path segment, so there is no shape of request this class can make that reads
 * somebody else's wallet. Staff look at other people's wallets through the admin console, which is a
 * different surface with a different check.</p>
 *
 * <p><b>There is no method here that buys, gifts, transfers, refunds or withdraws credit</b>, and
 * that is not an omission to be filled in later. Section 8.1 rules all five out as a hard rule, the
 * server has no route for any of them, and {@link purchase} deliberately only spends credit on
 * non-refundable time-boxed grants.</p>
 *
 * <p>Separate from `BillingService` because it is a separate contract - monetization.md section 8
 * rather than the checkout document - and because its refusals have a different body shape. The base
 * URL is read per call for the same reason it is there: this client is pointed at arbitrary
 * instances at runtime.</p>
 */
@Injectable({providedIn: 'root'})
export class CreditService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    /** The balance, the lots and the dates those lapse. 404 means credit does not exist here. */
    getWallet(): Observable<CreditWalletDto> {
        return this.http.get<CreditWalletDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me`);
    }

    /** The ledger in the server's own plain language, newest first. */
    getLedger(limit = 25): Observable<CreditLedgerDto> {
        return this.http.get<CreditLedgerDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me/ledger?limit=${limit}`);
    }

    /** What the balance can buy, in points and in cash, with the balance beside it. */
    getCatalogue(): Observable<CreditCatalogueDto> {
        return this.http.get<CreditCatalogueDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me/catalogue`);
    }

    /**
     * Spends credit on one SKU.
     *
     * <p>Touches no card and creates no invoice: nothing is being sold, so this is not a payment and
     * not a tax event. The response's `startsAt` is the field the caller must render - see
     * {@link CreditPurchaseDto}.</p>
     */
    purchase(request: PurchaseCreditRequest): Observable<CreditPurchaseDto> {
        return this.http.post<CreditPurchaseDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me/purchases`, request);
    }
}
