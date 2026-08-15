import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {SubscriptionCardComponent} from './subscription-card.component';
import {BillingService} from '../../../services/billing.service';
import {ProfileService} from '../../../services/profile.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {SubscriptionDto} from '../../../dtos/response/billing.dto';
import {formatMinor} from '../../../core/money';

function subscription(over: Partial<SubscriptionDto> = {}): SubscriptionDto {
    return {
        id: 'sub_1',
        subjectKind: 'guild',
        subjectId: 'gld_1',
        planName: 'pro',
        planDisplayName: 'Pro',
        versionNumber: 3,
        status: 'active',
        currentPeriodEnd: '2026-09-14T10:12:00Z',
        cancelAtPeriodEnd: false,
        gracePeriodEndsAt: null,
        priceMinorUnits: 2900,
        currency: 'usd',
        isPayer: true,
        ...over,
    };
}

function setup(opts: {
    subject?: EntitlementSubjectRef;
    subscriptions?: SubscriptionDto[];
    listError?: unknown;
    cancelResult?: SubscriptionDto;
    cancelError?: unknown;
    resumeError?: unknown;
} = {}) {
    let listed = 0;
    const list = vi.fn<() => Observable<SubscriptionDto[]>>(() => {
        listed++;
        return opts.listError
            ? throwError(() => opts.listError)
            : of(opts.subscriptions ?? [subscription()]);
    });

    const cancel = vi.fn<(id: string) => Observable<SubscriptionDto>>(() => opts.cancelError
        ? throwError(() => opts.cancelError)
        : of(opts.cancelResult ?? subscription({cancelAtPeriodEnd: true})));

    const resume = vi.fn<(id: string) => Observable<SubscriptionDto>>(() => opts.resumeError
        ? throwError(() => opts.resumeError)
        : of(subscription({cancelAtPeriodEnd: false})));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [SubscriptionCardComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {
                provide: BillingService,
                useValue: {
                    listSubscriptions: list,
                    cancelSubscription: cancel,
                    resumeSubscription: resume,
                    // The change dialog is a child of this card and asks for the catalogue when it
                    // opens. Nothing in this file opens it.
                    getCatalogue: () => of({enabled: true, currency: 'usd', plans: []}),
                    previewChange: () => of(null),
                    changePlan: () => of(subscription()),
                },
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'usr_9'})}},
            {provide: EntitlementStore, useValue: {invalidate: vi.fn(), ensureLoaded: vi.fn()}},
        ],
    });

    const fixture: ComponentFixture<SubscriptionCardComponent> =
        TestBed.createComponent(SubscriptionCardComponent);
    fixture.componentRef.setInput('subject', opts.subject ?? {kind: 'guild', id: 'gld_1'});
    fixture.detectChanges();

    return {fixture, list, cancel, resume, listCount: () => listed};
}

/**
 * Untranslated keys render as themselves, so assertions read against the key.
 *
 * <p>Read off `body` rather than off the fixture: the confirm dialog appends there, and the fixture
 * host is inside it anyway.</p>
 */
function text(_fixture: ComponentFixture<SubscriptionCardComponent>): string {
    return document.body.textContent ?? '';
}

function button(fixture: ComponentFixture<SubscriptionCardComponent>, label: string): HTMLElement {
    const scopes: ParentNode[] = [fixture.nativeElement, document.body];
    for (const scope of scopes) {
        const found = Array.from(scope.querySelectorAll('button'))
            .find(el => ((el as HTMLElement).textContent ?? '').includes(label));
        if (found) return found as HTMLElement;
    }
    throw new Error(`no button containing ${label}`);
}

function hasButton(fixture: ComponentFixture<SubscriptionCardComponent>, label: string): boolean {
    try {
        button(fixture, label);
        return true;
    } catch {
        return false;
    }
}

describe('what the card says about a live subscription', () => {
    it('names the plan, the price and when it renews', () => {
        const {fixture} = setup();
        const body = text(fixture);

        expect(body).toContain('Pro');
        // Through the shared formatter rather than as a literal: the card formats in the reader's
        // locale, and pinning the symbol here would assert the runner's ICU data instead.
        expect(body).toContain(formatMinor(2900, 'usd'));
        expect(body).toContain('BILLING.SUBSCRIPTION.RENEWS_ON');
    });

    /**
     * "$29.00" beside a renewal date leaves the reader to infer the cadence from a gap they cannot
     * both see, and get it wrong on an annual plan bought last week.
     */
    it('says the price as a rate rather than as a bare amount', () => {
        const {fixture} = setup({subscriptions: [subscription({interval: 'month'})]});
        const body = text(fixture);

        expect(body).toContain(formatMinor(2900, 'usd'));
        expect(body).toContain('BILLING.INTERVAL.MONTH');
    });

    it('says per year for an annual subscription', () => {
        const {fixture} = setup({subscriptions: [subscription({interval: 'year'})]});

        expect(text(fixture)).toContain('BILLING.INTERVAL.YEAR');
    });

    /** Null is the server saying it could not resolve the plan version. The amount still stands. */
    it('shows the amount alone when the server sent a null interval', () => {
        const {fixture} = setup({subscriptions: [subscription({interval: null})]});
        const body = text(fixture);

        expect(body).toContain(formatMinor(2900, 'usd'));
        expect(body).not.toContain('BILLING.INTERVAL.');
    });

    /** The rolling-deploy case: this build talks to services that predate the field entirely. */
    it('shows the amount alone when the field is absent from the payload', () => {
        const {fixture} = setup({subscriptions: [subscription()]});
        const body = text(fixture);

        expect(body).toContain(formatMinor(2900, 'usd'));
        expect(body).not.toContain('BILLING.INTERVAL.');
    });

    it('renders the standing rather than the raw provider status', () => {
        const {fixture} = setup({subscriptions: [subscription({status: 'active'})]});

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.STANDING.LIVE');
        // Stripe's own word, never on screen. The standing is what a person can read.
        expect(text(fixture)).not.toContain('active');
    });

    /**
     * Stripe adds statuses. Rendering one this build has never seen as "active" would hand out a
     * paid-for badge on the strength of a string nobody here has ever handled.
     */
    it('reads a status from a newer Stripe as needing attention, never as active', () => {
        const {fixture} = setup({subscriptions: [subscription({status: 'quantum_paused'})]});

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.STANDING.ATTENTION');
        expect(text(fixture)).not.toContain('BILLING.SUBSCRIPTION.STANDING.LIVE');
        expect(text(fixture)).not.toContain('quantum_paused');
    });

    /** The list carries every guild the caller manages, so a subject with none gets no card. */
    it('draws nothing at all for a subject with no subscription', () => {
        const {fixture} = setup({subscriptions: [subscription({subjectId: 'gld_other'})]});

        expect(text(fixture)).not.toContain('BILLING.SUBSCRIPTION.SECTION');
    });

    /** A guild subscribed, cancelled and subscribed again has both in the list. */
    it('shows the live subscription rather than the one that already ended', () => {
        const {fixture} = setup({
            subscriptions: [
                subscription({id: 'sub_old', status: 'canceled', planDisplayName: 'Old Pro'}),
                subscription({id: 'sub_new', status: 'active', planDisplayName: 'New Pro'}),
            ],
        });

        expect(text(fixture)).toContain('New Pro');
        expect(text(fixture)).not.toContain('Old Pro');
    });

    /** A failed read is not an account with no subscription, and the two must not look alike. */
    it('separates a read that failed from a subject that has nothing', () => {
        const {fixture} = setup({listError: new HttpErrorResponse({status: 500})});

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.LOAD_FAILED');
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.RETRY')).toBe(true);
    });
});

describe('a payment that failed', () => {
    /**
     * The single most important thing on this screen for the person most likely to be reading it.
     * A chip saying "past due" tells somebody whose card expired nothing they can act on.
     */
    it('states the grace period as a sentence with a date, not only as a status', () => {
        const {fixture} = setup({
            subscriptions: [subscription({status: 'past_due', gracePeriodEndsAt: '2026-03-03T00:00:00Z'})],
        });

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.GRACE_TITLE');
        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.GRACE_BODY');
    });

    it('says nothing of the sort while no payment has failed', () => {
        const {fixture} = setup();

        expect(text(fixture)).not.toContain('BILLING.SUBSCRIPTION.GRACE_TITLE');
    });

    /** "Update your card" is not something a manager who is not the payer can act on. */
    it('points a non-payer at whoever holds the card rather than at a card they cannot reach', () => {
        const {fixture} = setup({
            subscriptions: [subscription({
                status: 'past_due',
                gracePeriodEndsAt: '2026-03-03T00:00:00Z',
                isPayer: false,
            })],
        });

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.GRACE_BODY_OTHER');
    });
});

describe('somebody else is paying', () => {
    /**
     * Not disabled controls: they manage the guild and somebody else's card is behind it, so a
     * cancel button here would be a 403 with extra steps.
     */
    it('offers no actions at all, and says why', () => {
        const {fixture} = setup({subscriptions: [subscription({isPayer: false})]});

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.NOT_PAYER');
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.CANCEL')).toBe(false);
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.CHANGE')).toBe(false);
    });

    it('still shows them what the plan is and when it renews', () => {
        const {fixture} = setup({subscriptions: [subscription({isPayer: false})]});

        expect(text(fixture)).toContain('Pro');
        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.RENEWS_ON');
    });
});

describe('cancelling', () => {
    /** Reversible, and still confirmed: "cancelled" arriving unannounced is how people panic. */
    it('asks first and calls nothing until the confirmation is pressed', () => {
        const {fixture, cancel} = setup();

        button(fixture, 'BILLING.SUBSCRIPTION.CANCEL').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.CANCEL_TITLE');
        expect(cancel).not.toHaveBeenCalled();
    });

    /** The date is the whole point of the confirmation - nothing stops today. */
    it('names when access actually stops, in the body and on the button', () => {
        const {fixture} = setup();

        button(fixture, 'BILLING.SUBSCRIPTION.CANCEL').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.CANCEL_BODY');
        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.CANCEL_CONFIRM');
    });

    it('cancels the subscription it is showing and renders the end date the server sent back', () => {
        const {fixture, cancel} = setup();

        button(fixture, 'BILLING.SUBSCRIPTION.CANCEL').click();
        fixture.detectChanges();
        button(fixture, 'BILLING.SUBSCRIPTION.CANCEL_CONFIRM').click();
        fixture.detectChanges();

        expect(cancel).toHaveBeenCalledWith('sub_1');
        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.CANCELLING_TITLE');
        expect(text(fixture)).not.toContain('BILLING.SUBSCRIPTION.RENEWS_ON');
    });

    it('explains a refused cancellation rather than leaving the card unchanged and silent', () => {
        const {fixture} = setup({
            cancelError: new HttpErrorResponse({status: 403, error: {code: 'not_the_payer'}}),
        });

        button(fixture, 'BILLING.SUBSCRIPTION.CANCEL').click();
        fixture.detectChanges();
        button(fixture, 'BILLING.SUBSCRIPTION.CANCEL_CONFIRM').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.ERROR.NOT_THE_PAYER');
        expect(text(fixture)).not.toContain('403');
    });
});

describe('resuming', () => {
    it('offers resume instead of cancel once the subscription is winding down', () => {
        const {fixture} = setup({subscriptions: [subscription({cancelAtPeriodEnd: true})]});

        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.RESUME')).toBe(true);
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.CANCEL')).toBe(false);
    });

    it('clears the pending cancellation and goes back to renewing', () => {
        const {fixture, resume} = setup({subscriptions: [subscription({cancelAtPeriodEnd: true})]});

        button(fixture, 'BILLING.SUBSCRIPTION.RESUME').click();
        fixture.detectChanges();

        expect(resume).toHaveBeenCalledWith('sub_1');
        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.RENEWS_ON');
    });

    /**
     * The dead end this screen exists to avoid. The button they just pressed can never work again,
     * so the refusal points at the plans further down the same page.
     */
    it('sends a lapsed subscription to the plan list rather than to a dead end', () => {
        const {fixture, listCount} = setup({
            subscriptions: [subscription({cancelAtPeriodEnd: true})],
            resumeError: new HttpErrorResponse({status: 409, error: {code: 'subscription_lapsed'}}),
        });

        button(fixture, 'BILLING.SUBSCRIPTION.RESUME').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.ERROR.SUBSCRIPTION_LAPSED');
        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.LAPSED_HINT');
        // Re-read, because the card is showing a subscription the server says is over.
        expect(listCount()).toBe(2);
    });

    it('does not offer the plan list for a refusal that is not about lapsing', () => {
        const {fixture} = setup({
            subscriptions: [subscription({cancelAtPeriodEnd: true})],
            resumeError: new HttpErrorResponse({status: 502, error: {code: 'stripe_error'}}),
        });

        button(fixture, 'BILLING.SUBSCRIPTION.RESUME').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.ERROR.STRIPE');
        expect(text(fixture)).not.toContain('BILLING.SUBSCRIPTION.LAPSED_HINT');
    });
});

describe('a subscription that is over', () => {
    /** Nothing is left to cancel, resume or move, so none of it is drawn and then refused. */
    it('offers no actions on an ended subscription', () => {
        const {fixture} = setup({subscriptions: [subscription({status: 'canceled'})]});

        expect(text(fixture)).toContain('BILLING.SUBSCRIPTION.STANDING.ENDED');
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.CANCEL')).toBe(false);
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.RESUME')).toBe(false);
        expect(hasButton(fixture, 'BILLING.SUBSCRIPTION.CHANGE')).toBe(false);
    });
});

describe('which subject the card is about', () => {
    /** `me` is a routing shorthand in the store; the list keys user subscriptions by real id. */
    it('matches a user subscription against the account id rather than the literal me', () => {
        const {fixture} = setup({
            subject: MY_ENTITLEMENTS,
            subscriptions: [subscription({subjectKind: 'user', subjectId: 'usr_9', planDisplayName: 'Venta Plus'})],
        });

        expect(text(fixture)).toContain('Venta Plus');
    });

    /** An older service sends `Guild`. That subscription still belongs on the guild screen. */
    it('is not thrown by a subject kind that arrives in the other casing', () => {
        const {fixture} = setup({
            subscriptions: [subscription({subjectKind: 'Guild', planDisplayName: 'Pro Legacy'})],
        });

        expect(text(fixture)).toContain('Pro Legacy');
    });
});
