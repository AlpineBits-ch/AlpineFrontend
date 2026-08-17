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

/** The refusals the credit endpoints name, from `CreditErrorCodes` and `CreditPurchaseErrorCodes`. */
export const CREDIT_ERROR_CODES = {
    /** 400. The SKU is not on this instance's catalogue. */
    unknownSku: 'unknown_sku',
    /** 400. The SKU's plan has no cash price, so credit must not be the only route to it. */
    noCashPrice: 'no_cash_price',
    /** 400. A guild SKU with no guild named. */
    targetRequired: 'target_required',
    /** 400. The subject already holds this plan with no end date. Refused outright, and nothing is charged. */
    alreadyPermanent: 'already_permanent',
    /** 400. The wallet does not hold enough points. */
    insufficientBalance: 'insufficient_balance',
} as const;

export type CreditErrorCode = (typeof CREDIT_ERROR_CODES)[keyof typeof CREDIT_ERROR_CODES] | (string & {});

/** A credit refusal from the plain `{code, message}` body. Not `describeBillingError`: that one reads `detail`. */
export interface CreditFailure {
    /** Null when the body carried no code, which includes every response that is not JSON. */
    code: CreditErrorCode | null;
    status: number;
    /** The server's own sentence for this refusal. Customer-worded, and shown verbatim. */
    message: string | null;
    cause: HttpErrorResponse;
}

/** Reads a credit refusal, or null when this is not an HTTP error at all. */
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

/** Whether the instance is saying credit does not exist here: hide the surface, do not apologise on it. */
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
    return raw && typeof raw === 'object' ? (raw as JsonBody) : null;
}

function firstString(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return null;
}

/** The four caller-scoped credit routes (monetization.md section 8.8). No gift, transfer, refund or withdrawal exists. */
@Injectable({providedIn: 'root'})
export class CreditService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    /** The balance, the lots and the dates those lapse. 404 means credit does not exist here. */
    getWallet(): Observable<CreditWalletDto> {
        return this.http.get<CreditWalletDto>(`${this.apiConfig.baseUrl()}/api/v1/billing/credit/me`);
    }

    /** The ledger in the server's own plain language, newest first. */
    getLedger(limit = 25): Observable<CreditLedgerDto> {
        return this.http.get<CreditLedgerDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me/ledger?limit=${limit}`,
        );
    }

    /** What the balance can buy, in points and in cash, with the balance beside it. */
    getCatalogue(): Observable<CreditCatalogueDto> {
        return this.http.get<CreditCatalogueDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me/catalogue`,
        );
    }

    /** Spends credit on one SKU. Touches no card: the response's `startsAt` is what the caller must render. */
    purchase(request: PurchaseCreditRequest): Observable<CreditPurchaseDto> {
        return this.http.post<CreditPurchaseDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/credit/me/purchases`,
            request,
        );
    }
}
