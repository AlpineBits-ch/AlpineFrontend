import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ChangePlanRequest, CreateSubscriptionRequest} from '../dtos/request/billing.dto';
import {
    BillingCatalogueDto,
    ChangePreviewDto,
    CreateSubscriptionResponseDto,
    InvoiceDto,
    PaymentMethodDto,
    SetupIntentDto,
    SubscriptionDto,
} from '../dtos/response/billing.dto';

/**
 * The machine-readable codes in `billing-checkout-api-contract.md`, section 2.
 *
 * <p><b>Global across every endpoint in that document</b>, not per-endpoint. The first draft named
 * codes only for subscription creation and payment-method detach, which left cancel, resume, change
 * and preview with no named failures despite all four being able to refuse for reasons a person
 * would want explained.</p>
 *
 * <p>Open at the type level, like every other refusal vocabulary in this client: the set is closed
 * today and a build shipped today will eventually receive a code added tomorrow, and the rule for
 * that is a generic sentence rather than an unhandled branch.</p>
 */
export const BILLING_ERROR_CODES = {
    /** 404. Stripe is not configured here. Unreachable if the catalogue's `enabled` was honoured. */
    billingDisabled: 'billing_disabled',
    /** 400. The plan exists and is not sold. */
    notPurchasable: 'not_purchasable',
    /** 409. This subject already has a live subscription - offer "change plan" instead. */
    alreadySubscribed: 'already_subscribed',
    /** 403. The caller lacks `ManageGuild` on the subject. */
    notPermitted: 'not_permitted',
    /** 403. They do manage the guild, and somebody else's card is behind the subscription. */
    notThePayer: 'not_the_payer',
    /** 409. Resume was called on a subscription that has already ended. */
    subscriptionLapsed: 'subscription_lapsed',
    /** 409 on a detach: the only card, and a live subscription depends on it. */
    lastPaymentMethod: 'last_payment_method',
    /** 502. {@link BillingFailure.detail} is customer-worded and safe to display verbatim. */
    stripeError: 'stripe_error',
} as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[keyof typeof BILLING_ERROR_CODES] | (string & {});

/**
 * A billing refusal, read out of `application/problem+json` without losing the response it came in.
 *
 * <p>`cause` is not decoration. A caller that only receives a code cannot tell a 502 from a 400,
 * cannot retry on the ones worth retrying, and cannot report anything useful when the code is
 * absent - so the whole {@link HttpErrorResponse} travels with it and no `catchError` in this file
 * ever replaces one.</p>
 */
export interface BillingFailure {
    /** Null when the body carried no code, which includes every response that is not problem+json. */
    code: BillingErrorCode | null;
    status: number;
    /** The problem's `detail`, which is the sentence to show for `stripe_error`. */
    detail: string | null;
    title: string | null;
    cause: HttpErrorResponse;
}

/**
 * Reads a billing refusal, or null when this is not an HTTP error at all.
 *
 * <p>The code is looked for in two places because the contract says one and ASP.NET does the other:
 * `ProblemDetails.Extensions` is documented as an `extensions` object and is serialized <b>flat</b>
 * onto the problem body, so `{"code": "already_subscribed"}` and
 * `{"extensions": {"code": "already_subscribed"}}` are both shapes this has to accept. Checking one
 * of the two turns every refusal in the other family back into "something went wrong".</p>
 *
 * <p>A body that is not JSON at all - a proxy's HTML error page, a plain-text 500 - yields a null
 * code and a real status, which is exactly the distinction a caller needs to decide between naming
 * the reason and apologising generically.</p>
 */
export function describeBillingError(err: unknown): BillingFailure | null {
    if (!(err instanceof HttpErrorResponse)) return null;

    const body = problemBody(err.error);
    return {
        code: firstString(body?.code, body?.extensions?.code),
        status: err.status,
        detail: firstString(body?.detail),
        title: firstString(body?.title),
        cause: err,
    };
}

/** Convenience for the call sites that only want to switch on the code. */
export function billingErrorCode(err: unknown): BillingErrorCode | null {
    return describeBillingError(err)?.code ?? null;
}

interface ProblemBody {
    code?: unknown;
    detail?: unknown;
    title?: unknown;
    extensions?: {code?: unknown};
}

/**
 * The parsed problem body, or null when there is not one.
 *
 * <p>A string is re-parsed rather than ignored: `HttpClient` hands back the raw text when the
 * response could not be parsed as JSON, and a gateway that forwards problem+json under a
 * `text/plain` content type would otherwise lose every code it carried.</p>
 */
function problemBody(raw: unknown): ProblemBody | null {
    if (typeof raw === 'string') {
        try {
            return problemBody(JSON.parse(raw));
        } catch {
            return null;
        }
    }
    return raw && typeof raw === 'object' ? (raw as ProblemBody) : null;
}

function firstString(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return null;
}

/**
 * The billing API, one method per endpoint in `billing-checkout-api-contract.md`.
 *
 * <p>The base URL is read per call rather than cached in a field: this client is pointed at
 * arbitrary instances at runtime, and a URL captured at construction outlives the instance it was
 * built for. The `billing` segment is part of the public path - the gateway strips it before the
 * service sees it.</p>
 *
 * <p><b>No caching and no state.</b> Not even for the catalogue, which looks like the obvious
 * candidate: what is on sale is per-instance, and a cache here would be a second thing to
 * invalidate on the instance switch the store already handles. One request, one response, and the
 * error arrives as the {@link HttpErrorResponse} the server sent - see
 * {@link describeBillingError}.</p>
 *
 * <p>Nothing in this file grants an entitlement. A successful purchase means the card worked; only
 * the webhook makes a subscription live, so the caller polls {@link getSubscription} until the
 * status is active and then refreshes the entitlement snapshot.</p>
 */
@Injectable({providedIn: 'root'})
export class BillingService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    /** What is for sale, and whether anything is. Half of the two gates on any purchasing UI. */
    getCatalogue(): Observable<BillingCatalogueDto> {
        return this.http.get<BillingCatalogueDto>(`${this.apiConfig.baseUrl()}/api/v1/billing/catalogue`);
    }

    /**
     * Starts a subscription.
     *
     * <p>The response's `clientSecret` may be null, which means Stripe had nothing to confirm and
     * the caller should go straight to polling rather than treating it as a failure.</p>
     */
    createSubscription(request: CreateSubscriptionRequest): Observable<CreateSubscriptionResponseDto> {
        return this.http.post<CreateSubscriptionResponseDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions`,
            request,
        );
    }

    /** Everything the caller pays for, plus everything on guilds where they hold `ManageGuild`. */
    listSubscriptions(): Observable<SubscriptionDto[]> {
        return this.http.get<SubscriptionDto[]>(`${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions`);
    }

    /** One subscription. This is also the poll after a confirmed payment. */
    getSubscription(subscriptionId: string): Observable<SubscriptionDto> {
        return this.http.get<SubscriptionDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions/${subscriptionId}`,
        );
    }

    /**
     * Sets `cancel_at_period_end`. Payer only.
     *
     * <p>Nothing ends today, and the copy around this has to say when access actually stops. There
     * is no immediate-cancellation endpoint on purpose: a refund is a staff action in the support
     * console rather than a button in the app.</p>
     */
    cancelSubscription(subscriptionId: string): Observable<SubscriptionDto> {
        return this.http.post<SubscriptionDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions/${subscriptionId}/cancel`,
            {},
        );
    }

    /** Clears a pending cancellation. Valid only while the subscription has not yet lapsed. */
    resumeSubscription(subscriptionId: string): Observable<SubscriptionDto> {
        return this.http.post<SubscriptionDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions/${subscriptionId}/resume`,
            {},
        );
    }

    /**
     * What changing to another plan would cost, before anything is committed.
     *
     * <p>Show this. Proration is the most frequent billing support question and the preview is what
     * removes most of it - `immediateChargeMinorUnits` is negative when the change is a credit.</p>
     */
    previewChange(subscriptionId: string, request: ChangePlanRequest): Observable<ChangePreviewDto> {
        return this.http.post<ChangePreviewDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions/${subscriptionId}/preview-change`,
            request,
        );
    }

    /** Applies the change previewed above, with the same body. */
    changePlan(subscriptionId: string, request: ChangePlanRequest): Observable<SubscriptionDto> {
        return this.http.post<SubscriptionDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/subscriptions/${subscriptionId}/change`,
            request,
        );
    }

    /** Brand, last four and expiry. That is the whole of the card data on our side. */
    listPaymentMethods(): Observable<PaymentMethodDto[]> {
        return this.http.get<PaymentMethodDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/payment-methods`,
        );
    }

    /** The client secret for adding a card outside a purchase, via the same Payment Element. */
    createSetupIntent(): Observable<SetupIntentDto> {
        return this.http.post<SetupIntentDto>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/payment-methods/setup-intent`,
            {},
        );
    }

    setDefaultPaymentMethod(paymentMethodId: string): Observable<void> {
        return this.http.post<void>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/payment-methods/${paymentMethodId}/default`,
            {},
        );
    }

    /**
     * Detaches a card.
     *
     * <p>Refused with `last_payment_method` when it is the only one and a live subscription depends
     * on it. Stripe would otherwise accept the detach and fail the next invoice, which is a support
     * ticket rather than an error.</p>
     */
    deletePaymentMethod(paymentMethodId: string): Observable<void> {
        return this.http.delete<void>(
            `${this.apiConfig.baseUrl()}/api/v1/billing/payment-methods/${paymentMethodId}`,
        );
    }

    /** Receipts. Both URLs on an invoice are opened externally; we do not render invoices. */
    listInvoices(): Observable<InvoiceDto[]> {
        return this.http.get<InvoiceDto[]>(`${this.apiConfig.baseUrl()}/api/v1/billing/invoices`);
    }
}
