import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {CheckoutDialogComponent} from './checkout-dialog.component';
import {BillingService} from '../../../services/billing.service';
import {StripeLoaderService} from '../../../services/stripe-loader.service';
import {ProfileService} from '../../../services/profile.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {ACTIVATION_POLL_BACKOFF} from '../../../core/subscription-activation';
import {
    BillingPlanDto,
    CreateSubscriptionResponseDto,
    SubscriptionDto,
} from '../../../dtos/response/billing.dto';
import {CreateSubscriptionRequest} from '../../../dtos/request/billing.dto';

const PLAN: BillingPlanDto = {
    name: 'pro',
    displayName: 'Pro',
    description: 'For communities that stream.',
    versionNumber: 3,
    subjectKind: 'guild',
    priceMinorUnits: 2900,
    currency: 'usd',
    interval: 'month',
    purchasable: true,
    entitlements: {},
};

function subscription(status: string): SubscriptionDto {
    return {
        id: 'sub_1',
        subjectKind: 'guild',
        subjectId: 'gld_1',
        planName: 'pro',
        planDisplayName: 'Pro',
        versionNumber: 3,
        status,
        currentPeriodEnd: '2026-09-14T10:12:00Z',
        cancelAtPeriodEnd: false,
        gracePeriodEndsAt: null,
        priceMinorUnits: 2900,
        currency: 'usd',
        isPayer: true,
    };
}

function setup(
    opts: {
        subject?: EntitlementSubjectRef;
        clientSecret?: string | null;
        createError?: unknown;
        statuses?: string[];
    } = {},
) {
    const created = vi.fn<(r: CreateSubscriptionRequest) => Observable<CreateSubscriptionResponseDto>>(() =>
        opts.createError
            ? throwError(() => opts.createError)
            : of({subscription: subscription('incomplete'), clientSecret: opts.clientSecret ?? null}),
    );

    const statuses = opts.statuses ?? ['active'];
    let read = 0;
    const fetched = vi.fn<(id: string) => Observable<SubscriptionDto>>(() => {
        const status = statuses[Math.min(read, statuses.length - 1)];
        read++;
        return of(subscription(status));
    });

    const invalidate = vi.fn();
    const ensureLoaded = vi.fn();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [CheckoutDialogComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: BillingService, useValue: {createSubscription: created, getSubscription: fetched}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'usr_9'})}},
            {provide: EntitlementStore, useValue: {invalidate, ensureLoaded}},
            {
                provide: StripeLoaderService,
                useValue: {
                    configured: signal(true),
                    load: async () => ({stripe: null, reason: 'load_failed'}),
                },
            },
            // Three reads and no real waiting. The interesting property of the poll is what it does
            // when it runs out, and thirty seconds of it is a test nobody runs.
            {provide: ACTIVATION_POLL_BACKOFF, useValue: [1, 1]},
        ],
    });

    const fixture: ComponentFixture<CheckoutDialogComponent> =
        TestBed.createComponent(CheckoutDialogComponent);
    fixture.componentRef.setInput('plan', PLAN);
    fixture.componentRef.setInput('subject', opts.subject ?? {kind: 'guild', id: 'gld_1'});
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    return {fixture, created, fetched, invalidate, ensureLoaded};
}

/** The dialog appends to body, and the flow is a chain of promises plus two 1ms sleeps. */
async function settle(fixture: ComponentFixture<CheckoutDialogComponent>): Promise<string> {
    for (let i = 0; i < 8; i++) {
        await fixture.whenStable();
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    fixture.detectChanges();
    return document.body.textContent ?? '';
}

describe('starting a purchase', () => {
    it('asks Billing for the subscription with a lowercase subject kind and the guild id', async () => {
        const {fixture, created} = setup({subject: {kind: 'guild', id: 'gld_7'}});
        await settle(fixture);

        expect(created).toHaveBeenCalledWith({planName: 'pro', subjectKind: 'guild', subjectId: 'gld_7'});
    });

    /** `me` is a routing shorthand in the store. It is not an id the server takes. */
    it('sends the account id for a user plan, never the literal me', async () => {
        const {fixture, created} = setup({subject: MY_ENTITLEMENTS});
        await settle(fixture);

        expect(created).toHaveBeenCalledWith({planName: 'pro', subjectKind: 'user', subjectId: 'usr_9'});
    });

    it('mounts the card step when Stripe has something to confirm', async () => {
        const {fixture, fetched} = setup({clientSecret: 'pi_1_secret_x'});
        const body = await settle(fixture);

        expect(body).toContain('BILLING.CHECKOUT.PAY');
        // Nothing is polled until the card has been confirmed.
        expect(fetched).not.toHaveBeenCalled();
    });

    /** Null is a success. A client that treats it as an error refuses a purchase that worked. */
    it('goes straight to polling on a null clientSecret, with no card form at all', async () => {
        const {fixture, fetched} = setup({clientSecret: null});
        const body = await settle(fixture);

        expect(fetched).toHaveBeenCalledWith('sub_1');
        expect(body).not.toContain('BILLING.CHECKOUT.PAY');
    });
});

describe('waiting for the webhook', () => {
    it('re-reads the entitlements once the subscription is live, and says so', async () => {
        const subject: EntitlementSubjectRef = {kind: 'guild', id: 'gld_1'};
        const {fixture, invalidate, ensureLoaded} = setup({subject, statuses: ['active']});
        const body = await settle(fixture);

        expect(body).toContain('BILLING.CHECKOUT.DONE_TITLE');
        // Without this the store answers from a snapshot fetched before the plan moved, for as
        // long as its TTL lasts - so the customer sees the limits they just paid to raise.
        expect(invalidate).toHaveBeenCalledWith(subject);
        expect(ensureLoaded).toHaveBeenCalledWith(subject);
    });

    it('keeps polling through a pending status rather than giving up on the first read', async () => {
        const {fixture, fetched} = setup({statuses: ['incomplete', 'incomplete', 'active']});
        const body = await settle(fixture);

        expect(fetched).toHaveBeenCalledTimes(3);
        expect(body).toContain('BILLING.CHECKOUT.DONE_TITLE');
    });

    /**
     * The case this whole screen is shaped around. The payment went through, the webhook has not
     * landed yet, and saying "your payment failed" here would be the worst answer available.
     */
    it('says it is taking longer than usual when the wait runs out, and never that it failed', async () => {
        const {fixture, invalidate} = setup({statuses: ['incomplete']});
        const body = await settle(fixture);

        expect(body).toContain('BILLING.CHECKOUT.SLOW_TITLE');
        expect(body).not.toContain('BILLING.ERROR.NOT_ACTIVATED');
        // The activation is most likely moments away, so what is held is dropped either way.
        expect(invalidate).toHaveBeenCalled();
    });

    it('says the plan was not switched on for a subscription that reached a terminal status', async () => {
        const {fixture, invalidate} = setup({statuses: ['incomplete_expired']});
        const body = await settle(fixture);

        expect(body).toContain('BILLING.ERROR.NOT_ACTIVATED');
        // Nothing was granted, so nothing is re-read as though it had been.
        expect(invalidate).not.toHaveBeenCalled();
    });
});

describe('a purchase the server refuses', () => {
    it('offers the change-plan wording for a subject that already has a subscription', async () => {
        const {fixture, fetched} = setup({
            createError: new HttpErrorResponse({status: 409, error: {code: 'already_subscribed'}}),
        });
        const body = await settle(fixture);

        expect(body).toContain('BILLING.ERROR.ALREADY_SUBSCRIBED');
        expect(fetched).not.toHaveBeenCalled();
    });

    it('shows the provider sentence verbatim rather than a status code', async () => {
        const {fixture} = setup({
            createError: new HttpErrorResponse({
                status: 502,
                error: {code: 'stripe_error', detail: 'Your card was declined.'},
            }),
        });
        const body = await settle(fixture);

        expect(body).toContain('Your card was declined.');
        expect(body).not.toContain('502');
    });

    it('falls back to a generic sentence for a code this build has never heard of', async () => {
        const {fixture} = setup({
            createError: new HttpErrorResponse({status: 409, error: {code: 'quota_exhausted'}}),
        });
        const body = await settle(fixture);

        expect(body).toContain('BILLING.ERROR.GENERIC');
        expect(body).not.toContain('quota_exhausted');
    });
});
