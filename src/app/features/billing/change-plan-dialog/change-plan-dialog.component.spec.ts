import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, Subject, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {ChangePlanDialogComponent} from './change-plan-dialog.component';
import {BillingService} from '../../../services/billing.service';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {
    BillingCatalogueDto,
    BillingPlanDto,
    ChangePreviewDto,
    SubscriptionDto,
} from '../../../dtos/response/billing.dto';
import {ChangePlanRequest} from '../../../dtos/request/billing.dto';
import {formatMinor} from '../../../core/money';

function plan(over: Partial<BillingPlanDto> = {}): BillingPlanDto {
    return {
        name: 'plus',
        displayName: 'Plus',
        description: 'For communities that talk.',
        versionNumber: 2,
        subjectKind: 'guild',
        priceMinorUnits: 900,
        currency: 'usd',
        interval: 'month',
        purchasable: true,
        entitlements: {},
        ...over,
    };
}

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

function preview(over: Partial<ChangePreviewDto> = {}): ChangePreviewDto {
    return {
        immediateChargeMinorUnits: 1450,
        currency: 'usd',
        nextInvoiceTotalMinorUnits: 900,
        nextInvoiceAt: '2026-09-14T10:12:00Z',
        lines: [
            {description: 'Unused time on Pro', amountMinorUnits: -1450},
            {description: 'Remaining time on Plus', amountMinorUnits: 2900},
        ],
        ...over,
    };
}

function setup(
    opts: {
        subject?: EntitlementSubjectRef;
        plans?: BillingPlanDto[];
        catalogueError?: unknown;
        preview?: ChangePreviewDto;
        previewError?: unknown;
        changeError?: unknown;
        changeInFlight?: Subject<SubscriptionDto>;
    } = {},
) {
    const catalogue = vi.fn<() => Observable<BillingCatalogueDto>>(() =>
        opts.catalogueError
            ? throwError(() => opts.catalogueError)
            : of({
                  enabled: true,
                  currency: 'usd',
                  plans: opts.plans ?? [plan()],
              }),
    );

    const previewed = vi.fn<(id: string, r: ChangePlanRequest) => Observable<ChangePreviewDto>>(() =>
        opts.previewError ? throwError(() => opts.previewError) : of(opts.preview ?? preview()),
    );

    const changed = vi.fn<(id: string, r: ChangePlanRequest) => Observable<SubscriptionDto>>(() => {
        if (opts.changeInFlight) return opts.changeInFlight.asObservable();
        return opts.changeError
            ? throwError(() => opts.changeError)
            : of(subscription({planName: 'plus', planDisplayName: 'Plus', priceMinorUnits: 900}));
    });

    const invalidate = vi.fn();
    const ensureLoaded = vi.fn();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ChangePlanDialogComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {
                provide: BillingService,
                useValue: {getCatalogue: catalogue, previewChange: previewed, changePlan: changed},
            },
            {provide: EntitlementStore, useValue: {invalidate, ensureLoaded}},
        ],
    });

    const fixture: ComponentFixture<ChangePlanDialogComponent> =
        TestBed.createComponent(ChangePlanDialogComponent);
    const emitted: SubscriptionDto[] = [];
    fixture.componentRef.setInput('subscription', subscription());
    fixture.componentRef.setInput('subject', opts.subject ?? {kind: 'guild', id: 'gld_1'});
    fixture.componentRef.setInput('visible', true);
    fixture.componentInstance.changed.subscribe(s => emitted.push(s));
    fixture.detectChanges();

    return {fixture, catalogue, previewed, changed, invalidate, ensureLoaded, emitted};
}

/** The dialog appends to body, and untranslated keys render as themselves. */
function text(): string {
    return document.body.textContent ?? '';
}

/** An amount as the shared formatter renders it here. */
function money(minor: number, currency = 'usd'): string {
    return formatMinor(minor, currency);
}

function options(): HTMLInputElement[] {
    return Array.from(document.body.querySelectorAll('input[type="radio"]'));
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.body.querySelectorAll('button')).find(el =>
        ((el as HTMLElement).textContent ?? '').includes(label),
    );
    if (!found) throw new Error(`no button containing ${label}`);
    return found as HTMLButtonElement;
}

function pick(fixture: ComponentFixture<ChangePlanDialogComponent>, index = 0): void {
    options()[index].click();
    fixture.detectChanges();
}

describe('what a subscription can move to', () => {
    it('offers the other plans on the same side of the product', () => {
        const {fixture} = setup({plans: [plan(), plan({name: 'pro', displayName: 'Pro'})]});
        fixture.detectChanges();

        expect(text()).toContain('Plus');
        expect(options()).toHaveLength(1);
    });

    /** Moving to the plan they are already on is not a change; it is a wasted invoice. */
    it('never offers the plan the subscription is already on', () => {
        const {fixture} = setup({plans: [plan({name: 'pro', displayName: 'Pro'})]});
        fixture.detectChanges();

        expect(options()).toHaveLength(0);
        expect(text()).toContain('BILLING.CHANGE.NO_OPTIONS');
    });

    it('leaves out plans that are not sold and plans for the other subject kind', () => {
        const {fixture} = setup({
            plans: [
                plan({name: 'free', displayName: 'Free', purchasable: false, priceMinorUnits: null}),
                plan({name: 'venta_plus', displayName: 'Venta Plus', subjectKind: 'user'}),
                plan(),
            ],
        });
        fixture.detectChanges();

        expect(options()).toHaveLength(1);
        expect(text()).not.toContain('Venta Plus');
        expect(text()).not.toContain('Free');
    });

    it('says so, and offers a retry, when the catalogue would not load', () => {
        const {fixture} = setup({catalogueError: new HttpErrorResponse({status: 500})});
        fixture.detectChanges();

        expect(text()).toContain('BILLING.ERROR.GENERIC');
        expect(() => button('BILLING.PLANS.RETRY')).not.toThrow();
    });
});

describe('the proration preview', () => {
    /** The reason this is two steps: the amount is neither price, and it is asked about constantly. */
    it('is asked for as soon as a plan is picked, and not before', () => {
        const {fixture, previewed} = setup();
        fixture.detectChanges();

        expect(previewed).not.toHaveBeenCalled();
        expect(text()).toContain('BILLING.CHANGE.PICK_HINT');

        pick(fixture);

        expect(previewed).toHaveBeenCalledWith('sub_1', {planName: 'plus'});
    });

    it('states the immediate charge in words as well as in figures', () => {
        const {fixture} = setup({preview: preview({immediateChargeMinorUnits: 1450})});
        fixture.detectChanges();
        pick(fixture);

        expect(text()).toContain('BILLING.CHANGE.CHARGE_NOW');
        expect(text()).toContain(money(1450));
    });

    /**
     * The case a minus sign alone cannot carry. The lines below are also negative, for a completely
     * different reason, so the headline says "credited" in words.
     */
    it('says credited, not minus, when the change gives money back', () => {
        const {fixture} = setup({preview: preview({immediateChargeMinorUnits: -500})});
        fixture.detectChanges();
        pick(fixture);

        expect(text()).toContain('BILLING.CHANGE.CREDIT_NOW');
        expect(text()).not.toContain('BILLING.CHANGE.CHARGE_NOW');
    });

    it('has a different sentence again for a change that costs nothing today', () => {
        const {fixture} = setup({preview: preview({immediateChargeMinorUnits: 0})});
        fixture.detectChanges();
        pick(fixture);

        expect(text()).toContain('BILLING.CHANGE.NO_CHARGE');
        // No headline figure at all: "you will be charged 0.00 now" reads as a bug.
        expect(text()).not.toContain(money(0));
    });

    it('renders every line the server sent, with its own sign', () => {
        const {fixture} = setup();
        fixture.detectChanges();
        pick(fixture);

        expect(text()).toContain('Unused time on Pro');
        expect(text()).toContain(money(-1450));
        expect(text()).toContain('Remaining time on Plus');
        expect(text()).toContain(money(2900));
    });

    it('names what the next invoice will be and when it lands', () => {
        const {fixture} = setup();
        fixture.detectChanges();
        pick(fixture);

        expect(text()).toContain('BILLING.CHANGE.NEXT_INVOICE');
    });

    it('asks again when the selection moves to another plan', () => {
        const {fixture, previewed} = setup({
            plans: [plan(), plan({name: 'ultra', displayName: 'Ultra', priceMinorUnits: 9900})],
        });
        fixture.detectChanges();

        pick(fixture, 0);
        pick(fixture, 1);

        expect(previewed).toHaveBeenCalledTimes(2);
        expect(previewed).toHaveBeenLastCalledWith('sub_1', {planName: 'ultra'});
    });

    /**
     * The failure must not strand them. The choice they made is still good; only the request went
     * wrong, so the selection survives and the retry re-asks for the same plan.
     */
    it('keeps the selection and offers a retry when the preview fails', () => {
        const {fixture, previewed} = setup({previewError: new HttpErrorResponse({status: 500})});
        fixture.detectChanges();
        pick(fixture);

        expect(text()).toContain('BILLING.ERROR.GENERIC');
        expect(options()[0].checked).toBe(true);

        button('BILLING.CHANGE.PREVIEW_RETRY').click();
        fixture.detectChanges();

        expect(previewed).toHaveBeenCalledTimes(2);
        expect(previewed).toHaveBeenLastCalledWith('sub_1', {planName: 'plus'});
    });
});

describe('committing the change', () => {
    /** Nothing is confirmable until a preview for this exact selection has been read back. */
    it('will not commit anything before a preview has been seen', () => {
        const {fixture, changed} = setup();
        fixture.detectChanges();

        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();

        expect(changed).not.toHaveBeenCalled();
    });

    it('applies the selected plan and re-reads the ceilings it just moved', () => {
        const subject: EntitlementSubjectRef = {kind: 'guild', id: 'gld_1'};
        const {fixture, changed, invalidate, ensureLoaded, emitted} = setup({subject});
        fixture.detectChanges();
        pick(fixture);

        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();

        expect(changed).toHaveBeenCalledWith('sub_1', {planName: 'plus'});
        // Without this the store answers from a set fetched before the plan moved, for as long as
        // its TTL lasts, and the customer sees the limits they just paid to change.
        expect(invalidate).toHaveBeenCalledWith(subject);
        expect(ensureLoaded).toHaveBeenCalledWith(subject);
        expect(emitted).toHaveLength(1);
        expect(text()).toContain('BILLING.CHANGE.DONE_TITLE');
    });

    /** A double-submitted plan change is a second invoice, not a cosmetic problem. */
    it('cannot be fired twice while the first one is still in flight', () => {
        const inFlight = new Subject<SubscriptionDto>();
        const {fixture, changed} = setup({changeInFlight: inFlight});
        fixture.detectChanges();
        pick(fixture);

        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();
        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();

        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('explains a refused change and leaves the dialog open to try again', () => {
        const {fixture, emitted} = setup({
            changeError: new HttpErrorResponse({status: 403, error: {code: 'not_the_payer'}}),
        });
        fixture.detectChanges();
        pick(fixture);

        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();

        expect(text()).toContain('BILLING.ERROR.NOT_THE_PAYER');
        expect(text()).not.toContain('BILLING.CHANGE.DONE_TITLE');
        expect(emitted).toHaveLength(0);
    });

    it('shows the provider sentence verbatim rather than a status code', () => {
        const {fixture} = setup({
            changeError: new HttpErrorResponse({
                status: 502,
                error: {code: 'stripe_error', detail: 'Your card was declined.'},
            }),
        });
        fixture.detectChanges();
        pick(fixture);

        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();

        expect(text()).toContain('Your card was declined.');
        expect(text()).not.toContain('502');
    });

    /** Nothing moved, so nothing is re-read as though it had. */
    it('drops nothing from the entitlement store when the change was refused', () => {
        const {fixture, invalidate} = setup({
            changeError: new HttpErrorResponse({status: 500}),
        });
        fixture.detectChanges();
        pick(fixture);

        button('BILLING.CHANGE.CONFIRM').click();
        fixture.detectChanges();

        expect(invalidate).not.toHaveBeenCalled();
    });
});
