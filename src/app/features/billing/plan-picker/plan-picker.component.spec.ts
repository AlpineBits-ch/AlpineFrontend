import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import type {Stripe} from '@stripe/stripe-js';
import {describe, expect, it} from 'vitest';
import {PlanPickerComponent} from './plan-picker.component';
import {ApiConfigService} from '../../../services/api-config.service';
import {STRIPE_JS_LOADER} from '../../../services/stripe-loader.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {BillingCatalogueDto, BillingPlanDto} from '../../../dtos/response/billing.dto';

const BASE = 'https://api.test.example';

/** Stripe.js is never reached in these tests; only the presence of a key is ever asserted. */
const STRIPE = {id: 'stripe'} as unknown as Stripe;

function plan(over: Partial<BillingPlanDto> = {}): BillingPlanDto {
    return {
        name: 'pro',
        displayName: 'Pro',
        description: 'For communities that stream.',
        versionNumber: 3,
        subjectKind: 'guild',
        priceMinorUnits: 2900,
        currency: 'usd',
        interval: 'month',
        purchasable: true,
        entitlements: {'voice.max_participants': {kind: 'numeric', value: 75, unlimited: false}},
        ...over,
    };
}

function catalogue(over: Partial<BillingCatalogueDto> = {}): BillingCatalogueDto {
    return {enabled: true, currency: 'usd', plans: [plan()], ...over};
}

function setup(opts: {
    subject?: EntitlementSubjectRef;
    publishableKey?: string;
    currentPlan?: string;
} = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [PlanPickerComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: STRIPE_JS_LOADER, useValue: async () => STRIPE},
            {
                provide: EntitlementStore,
                useValue: {
                    plan: () => opts.currentPlan ? {name: opts.currentPlan, displayName: 'X'} : null,
                    ensureLoaded: () => undefined,
                    stripePublishableKey: signal(opts.publishableKey ?? 'pk_test_x'),
                },
            },
        ],
    });

    const fixture: ComponentFixture<PlanPickerComponent> = TestBed.createComponent(PlanPickerComponent);
    fixture.componentRef.setInput('subject', opts.subject ?? {kind: 'guild', id: 'gld_1'});
    fixture.detectChanges();
    return {fixture, ctrl: TestBed.inject(HttpTestingController)};
}

function answer(ctrl: HttpTestingController, body: BillingCatalogueDto): void {
    ctrl.expectOne(`${BASE}/api/v1/billing/catalogue`).flush(body);
}

/** Untranslated keys render as themselves, so assertions read against the key. */
function text(fixture: ComponentFixture<PlanPickerComponent>): string {
    return fixture.nativeElement.textContent as string;
}

function buyButtons(fixture: ComponentFixture<PlanPickerComponent>): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('button'))
        .filter(el => ((el as HTMLElement).textContent ?? '').includes('BILLING.PLANS.CHOOSE')) as HTMLElement[];
}

describe('the plan comparison', () => {
    it('lists only the plans sold against this kind of subject', () => {
        const {fixture, ctrl} = setup({subject: {kind: 'guild', id: 'gld_1'}});
        answer(ctrl, catalogue({
            plans: [plan(), plan({name: 'venta_plus', displayName: 'Venta Plus', subjectKind: 'user'})],
        }));
        fixture.detectChanges();

        expect(text(fixture)).toContain('Pro');
        expect(text(fixture)).not.toContain('Venta Plus');
    });

    /** The two casings the service has shipped both mean the same side of the product. */
    it('matches the subject kind whatever case it arrived in', () => {
        const {fixture, ctrl} = setup({subject: MY_ENTITLEMENTS});
        answer(ctrl, catalogue({
            plans: [plan({name: 'venta_plus', displayName: 'Venta Plus', subjectKind: 'User'})],
        }));
        fixture.detectChanges();

        expect(text(fixture)).toContain('Venta Plus');
    });

    it('marks what the subject is already on and offers no button to buy it again', () => {
        const {fixture, ctrl} = setup({currentPlan: 'pro'});
        answer(ctrl, catalogue());
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.PLANS.CURRENT');
        expect(buyButtons(fixture)).toHaveLength(0);
    });

    /** The price is formatted from the plan's own currency, and never divided by hand. */
    it('renders the price from minor units and the currency on the payload', () => {
        const {fixture, ctrl} = setup();
        answer(ctrl, catalogue());
        fixture.detectChanges();

        expect(text(fixture)).toContain('29.00');
        expect(text(fixture)).not.toContain('2900');
    });

    /** JPY has no minor unit at all, which is what a hand-rolled `/100` gets wrong by a hundred. */
    it('respects a currency with no minor unit', () => {
        const {fixture, ctrl} = setup();
        answer(ctrl, catalogue({plans: [plan({priceMinorUnits: 2900, currency: 'jpy'})]}));
        fixture.detectChanges();

        expect(text(fixture)).not.toContain('29.00');
    });

    /** `free` arrives with no price precisely so the table has something to compare against. */
    it('shows a plan with no price rather than dropping it from the comparison', () => {
        const {fixture, ctrl} = setup();
        answer(ctrl, catalogue({
            plans: [plan({name: 'free', displayName: 'Free', priceMinorUnits: null, purchasable: false})],
        }));
        fixture.detectChanges();

        expect(text(fixture)).toContain('Free');
        expect(text(fixture)).toContain('BILLING.PLANS.NO_PRICE');
        expect(buyButtons(fixture)).toHaveLength(0);
    });

    it('renders one row per key any plan mentions, and says so where a plan does not', () => {
        const {fixture, ctrl} = setup();
        answer(ctrl, catalogue({
            plans: [
                plan({name: 'free', displayName: 'Free', priceMinorUnits: null, purchasable: false,
                    entitlements: {'voice.max_participants': {kind: 'numeric', value: 10, unlimited: false}}}),
                plan({entitlements: {
                    'voice.max_participants': {kind: 'numeric', value: 75, unlimited: false},
                    'guild.bots_installed': {kind: 'numeric', value: null, unlimited: true},
                }}),
            ],
        }));
        fixture.detectChanges();

        expect(text(fixture)).toContain('ENTITLEMENT.KEY.VOICE_MAX_PARTICIPANTS');
        // The union, not the intersection: the key only the paid tier carries is the difference
        // somebody comparing plans came here to see.
        expect(text(fixture)).toContain('ENTITLEMENT.KEY.GUILD_BOTS_INSTALLED');
        expect(text(fixture)).toContain('BILLING.VALUE.UNLIMITED');
        expect(text(fixture)).toContain('BILLING.VALUE.ABSENT');
    });
});

describe('the two gates on a buy button', () => {
    it('draws one when the catalogue is enabled and a publishable key exists', () => {
        const {fixture, ctrl} = setup({publishableKey: 'pk_test_x'});
        answer(ctrl, catalogue({enabled: true}));
        fixture.detectChanges();

        expect(buyButtons(fixture)).toHaveLength(1);
    });

    /** Answered by the service that holds the secret key, and the only honest answer to it. */
    it('draws none at all when the catalogue says nothing is enabled', () => {
        const {fixture, ctrl} = setup({publishableKey: 'pk_test_x'});
        answer(ctrl, catalogue({enabled: false}));
        fixture.detectChanges();

        // Absent, not disabled: the plans still render so the comparison is worth reading.
        expect(buyButtons(fixture)).toHaveLength(0);
        expect(text(fixture)).toContain('Pro');
    });

    it('draws none at all when the instance published no key', () => {
        const {fixture, ctrl} = setup({publishableKey: ''});
        answer(ctrl, catalogue({enabled: true}));
        fixture.detectChanges();

        expect(buyButtons(fixture)).toHaveLength(0);
    });

    it('draws none while the catalogue is still in flight, which is the safe default', () => {
        const {fixture} = setup({publishableKey: 'pk_test_x'});

        expect(buyButtons(fixture)).toHaveLength(0);
        expect(text(fixture)).toContain('BILLING.PLANS.LOADING');
    });
});

describe('a catalogue that would not load', () => {
    it('says so and offers a retry rather than rendering as an instance that sells nothing', () => {
        const {fixture, ctrl} = setup();
        ctrl.expectOne(`${BASE}/api/v1/billing/catalogue`)
            .flush('boom', {status: 500, statusText: 'Server Error'});
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.ERROR.GENERIC');
        expect(text(fixture)).toContain('BILLING.PLANS.RETRY');
        expect(text(fixture)).not.toContain('BILLING.PLANS.NONE');
    });
});
