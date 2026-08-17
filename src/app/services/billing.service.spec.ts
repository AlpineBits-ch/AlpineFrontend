import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse, provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {ApiConfigService} from './api-config.service';
import {BILLING_ERROR_CODES, BillingService, billingErrorCode, describeBillingError} from './billing.service';
import {SubscriptionDto} from '../dtos/response/billing.dto';

const BASE = 'https://api.test.example';
const BILLING = `${BASE}/api/v1/billing`;

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(BillingService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

/** Enough of a subscription to be flushed as one. Only the id is ever asserted. */
const SUBSCRIPTION = {id: 'sub_1', planName: 'pro'} as SubscriptionDto;

describe('BillingService - the catalogue', () => {
    it('GETs /billing/catalogue', () => {
        const {service, ctrl} = setup();
        let received: unknown = null;
        service.getCatalogue().subscribe(c => (received = c));

        const req = ctrl.expectOne(`${BILLING}/catalogue`);
        expect(req.request.method).toBe('GET');
        req.flush({enabled: true, currency: 'usd', plans: []});

        expect(received).toEqual({enabled: true, currency: 'usd', plans: []});
        ctrl.verify();
    });
});

describe('BillingService - subscriptions', () => {
    it('POSTs the create body verbatim', () => {
        const {service, ctrl} = setup();
        const body = {planName: 'pro', subjectKind: 'Guild' as const, subjectId: 'gld_1'};
        service.createSubscription(body).subscribe();

        const req = ctrl.expectOne(`${BILLING}/subscriptions`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual(body);
        req.flush({subscription: SUBSCRIPTION, clientSecret: null});
        ctrl.verify();
    });

    it('passes a null clientSecret through as null rather than as a failure', () => {
        const {service, ctrl} = setup();
        let secret: string | null | undefined;
        service
            .createSubscription({planName: 'pro', subjectKind: 'User', subjectId: 'usr_1'})
            .subscribe(r => (secret = r.clientSecret));

        ctrl.expectOne(`${BILLING}/subscriptions`).flush({subscription: SUBSCRIPTION, clientSecret: null});

        expect(secret).toBeNull();
        ctrl.verify();
    });

    it('GETs the list and one by id', () => {
        const {service, ctrl} = setup();
        service.listSubscriptions().subscribe();
        const list = ctrl.expectOne(`${BILLING}/subscriptions`);
        expect(list.request.method).toBe('GET');
        list.flush([SUBSCRIPTION]);

        service.getSubscription('sub_1').subscribe();
        const one = ctrl.expectOne(`${BILLING}/subscriptions/sub_1`);
        expect(one.request.method).toBe('GET');
        one.flush(SUBSCRIPTION);

        ctrl.verify();
    });

    it('POSTs cancel and resume with no meaningful body', () => {
        const {service, ctrl} = setup();
        service.cancelSubscription('sub_1').subscribe();
        const cancel = ctrl.expectOne(`${BILLING}/subscriptions/sub_1/cancel`);
        expect(cancel.request.method).toBe('POST');
        expect(cancel.request.body).toEqual({});
        cancel.flush(SUBSCRIPTION);

        service.resumeSubscription('sub_1').subscribe();
        const resume = ctrl.expectOne(`${BILLING}/subscriptions/sub_1/resume`);
        expect(resume.request.method).toBe('POST');
        resume.flush(SUBSCRIPTION);

        ctrl.verify();
    });

    it('POSTs preview-change and change with the same body to different paths', () => {
        const {service, ctrl} = setup();
        service.previewChange('sub_1', {planName: 'plus'}).subscribe();
        const preview = ctrl.expectOne(`${BILLING}/subscriptions/sub_1/preview-change`);
        expect(preview.request.method).toBe('POST');
        expect(preview.request.body).toEqual({planName: 'plus'});
        preview.flush({
            immediateChargeMinorUnits: -1450,
            currency: 'usd',
            nextInvoiceTotalMinorUnits: 900,
            nextInvoiceAt: '2026-09-14T10:12:00Z',
            lines: [],
        });

        service.changePlan('sub_1', {planName: 'plus'}).subscribe();
        const change = ctrl.expectOne(`${BILLING}/subscriptions/sub_1/change`);
        expect(change.request.method).toBe('POST');
        expect(change.request.body).toEqual({planName: 'plus'});
        change.flush(SUBSCRIPTION);

        ctrl.verify();
    });
});

describe('BillingService - payment methods and invoices', () => {
    it('GETs the payment methods', () => {
        const {service, ctrl} = setup();
        service.listPaymentMethods().subscribe();
        const req = ctrl.expectOne(`${BILLING}/payment-methods`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
        ctrl.verify();
    });

    it('POSTs for a setup intent', () => {
        const {service, ctrl} = setup();
        let secret: string | undefined;
        service.createSetupIntent().subscribe(r => (secret = r.clientSecret));

        const req = ctrl.expectOne(`${BILLING}/payment-methods/setup-intent`);
        expect(req.request.method).toBe('POST');
        req.flush({clientSecret: 'seti_1_secret_x'});

        expect(secret).toBe('seti_1_secret_x');
        ctrl.verify();
    });

    it('POSTs to make one the default and DELETEs to detach', () => {
        const {service, ctrl} = setup();
        service.setDefaultPaymentMethod('pm_1').subscribe();
        const setDefault = ctrl.expectOne(`${BILLING}/payment-methods/pm_1/default`);
        expect(setDefault.request.method).toBe('POST');
        setDefault.flush(null, {status: 204, statusText: 'No Content'});

        service.deletePaymentMethod('pm_1').subscribe();
        const detach = ctrl.expectOne(`${BILLING}/payment-methods/pm_1`);
        expect(detach.request.method).toBe('DELETE');
        detach.flush(null, {status: 204, statusText: 'No Content'});

        ctrl.verify();
    });

    it('GETs the invoices', () => {
        const {service, ctrl} = setup();
        service.listInvoices().subscribe();
        const req = ctrl.expectOne(`${BILLING}/invoices`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
        ctrl.verify();
    });
});

describe('BillingService - the base URL is read per call', () => {
    it('follows an instance switch instead of a URL captured at construction', () => {
        let base = BASE;
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => base}},
            ],
        });
        const service = TestBed.inject(BillingService);
        const ctrl = TestBed.inject(HttpTestingController);

        service.getCatalogue().subscribe();
        ctrl.expectOne(`${BASE}/api/v1/billing/catalogue`).flush({
            enabled: false,
            currency: 'usd',
            plans: [],
        });

        base = 'https://other.example';
        service.getCatalogue().subscribe();
        ctrl.expectOne('https://other.example/api/v1/billing/catalogue').flush({
            enabled: false,
            currency: 'usd',
            plans: [],
        });

        ctrl.verify();
    });
});

describe('describeBillingError', () => {
    it('reads the code off a flat problem+json 409, and keeps the response', () => {
        const {service, ctrl} = setup();
        let err: unknown = null;
        service
            .createSubscription({planName: 'pro', subjectKind: 'Guild', subjectId: 'gld_1'})
            .subscribe({error: e => (err = e)});

        ctrl.expectOne(`${BILLING}/subscriptions`).flush(
            {
                type: 'https://venta.gg/problems/already-subscribed',
                title: 'Already subscribed',
                status: 409,
                detail: 'This guild already has a live subscription.',
                code: BILLING_ERROR_CODES.alreadySubscribed,
            },
            {status: 409, statusText: 'Conflict'},
        );

        const failure = describeBillingError(err);
        expect(failure?.code).toBe('already_subscribed');
        expect(failure?.status).toBe(409);
        expect(failure?.detail).toBe('This guild already has a live subscription.');
        expect(failure?.title).toBe('Already subscribed');
        // The error itself is not swallowed: the caller can still see what came back.
        expect(failure?.cause).toBeInstanceOf(HttpErrorResponse);
        expect(failure?.cause.status).toBe(409);
        ctrl.verify();
    });

    it('also reads a code nested under extensions, which is how the contract writes it', () => {
        const err = new HttpErrorResponse({
            status: 409,
            error: {status: 409, extensions: {code: 'last_payment_method'}},
        });
        expect(billingErrorCode(err)).toBe('last_payment_method');
    });

    it('reports a null code and a real status for a 500 that is not problem+json', () => {
        const {service, ctrl} = setup();
        let err: unknown = null;
        service.listInvoices().subscribe({error: e => (err = e)});

        ctrl.expectOne(`${BILLING}/invoices`).flush('<html>502 Bad Gateway</html>', {
            status: 500,
            statusText: 'Server Error',
        });

        const failure = describeBillingError(err);
        expect(failure).not.toBeNull();
        // Null rather than a guess. "We do not know why" and "the plan is not sold" are different
        // sentences, and only one of them is honest here.
        expect(failure?.code).toBeNull();
        expect(failure?.status).toBe(500);
        expect(failure?.cause.status).toBe(500);
        ctrl.verify();
    });

    it('parses a problem body that arrived as text rather than as parsed JSON', () => {
        const err = new HttpErrorResponse({
            status: 502,
            error: '{"status":502,"code":"stripe_error","detail":"Your card was declined."}',
        });
        const failure = describeBillingError(err);
        expect(failure?.code).toBe('stripe_error');
        expect(failure?.detail).toBe('Your card was declined.');
    });

    it('returns null for something that is not an HTTP error at all', () => {
        expect(describeBillingError(new Error('boom'))).toBeNull();
        expect(describeBillingError(null)).toBeNull();
        expect(billingErrorCode(undefined)).toBeNull();
    });
});
