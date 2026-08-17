import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, Subject, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {CreditPurchaseDialogComponent} from './credit-purchase-dialog.component';
import {CreditService} from '../../../services/credit.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {PurchaseCreditRequest} from '../../../dtos/request/credit.dto';
import {CreditPurchaseDto, CreditSkuDto} from '../../../dtos/response/credit.dto';

function sku(over: Partial<CreditSkuDto> = {}): CreditSkuDto {
    return {
        code: 'guild_pro_30d',
        title: '30 days of Pro',
        description: 'Pro limits on one server for a month.',
        pricePoints: 400,
        cashPriceMinorUnits: 2900,
        cashCurrency: 'usd',
        plan: 'pro',
        durationDays: 30,
        subject: 'Guild',
        ...over,
    };
}

function purchase(over: Partial<CreditPurchaseDto> = {}): CreditPurchaseDto {
    return {
        skuCode: 'guild_pro_30d',
        grantId: 'grant_1',
        subjectKind: 'Guild',
        subjectId: 'gld_1',
        spent: 400,
        balanceAfter: 100,
        startsAt: '2026-08-15T12:00:00Z',
        expiresAt: '2026-09-14T12:00:00Z',
        wasQueued: false,
        ...over,
    };
}

function setup(
    opts: {
        subject?: EntitlementSubjectRef;
        sku?: CreditSkuDto;
        balance?: number;
        result?: CreditPurchaseDto;
        error?: unknown;
        /** Fails the first call and succeeds afterwards, for the retry path. */
        failFirst?: boolean;
        inFlight?: Subject<CreditPurchaseDto>;
    } = {},
) {
    let calls = 0;
    const buy = vi.fn<(r: PurchaseCreditRequest) => Observable<CreditPurchaseDto>>(() => {
        calls++;
        if (opts.inFlight) return opts.inFlight.asObservable();
        if (opts.error) return throwError(() => opts.error);
        if (opts.failFirst && calls === 1) {
            return throwError(() => new HttpErrorResponse({status: 500}));
        }
        return of(opts.result ?? purchase());
    });

    const invalidate = vi.fn();
    const ensureLoaded = vi.fn();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [CreditPurchaseDialogComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: CreditService, useValue: {purchase: buy}},
            {provide: EntitlementStore, useValue: {invalidate, ensureLoaded}},
        ],
    });

    const fixture: ComponentFixture<CreditPurchaseDialogComponent> = TestBed.createComponent(
        CreditPurchaseDialogComponent,
    );
    const emitted: CreditPurchaseDto[] = [];
    fixture.componentRef.setInput('sku', opts.sku ?? sku());
    fixture.componentRef.setInput('subject', opts.subject ?? {kind: 'guild', id: 'gld_1'});
    fixture.componentRef.setInput('balance', opts.balance ?? 500);
    fixture.componentRef.setInput('visible', true);
    fixture.componentInstance.purchased.subscribe(p => emitted.push(p));
    fixture.detectChanges();

    return {fixture, buy, invalidate, ensureLoaded, emitted};
}

/** The dialog appends to body, and untranslated keys render as themselves. */
function text(): string {
    return document.body.textContent ?? '';
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.body.querySelectorAll('button')).find(el =>
        ((el as HTMLElement).textContent ?? '').includes(label),
    );
    if (!found) throw new Error(`no button containing ${label}`);
    return found as HTMLButtonElement;
}

function keysUsed(buy: ReturnType<typeof setup>['buy']): string[] {
    return buy.mock.calls.map(([request]) => request.idempotencyKey);
}

function reopen(fixture: ComponentFixture<CreditPurchaseDialogComponent>): void {
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
}

describe('what the dialog says before anything is spent', () => {
    /** Both halves of the price, so nobody has to guess what a credit is worth before spending. */
    it('shows the point price and the cash price side by side', () => {
        setup();
        const body = text();

        expect(body).toContain('30 days of Pro');
        expect(body).toContain('BILLING.CREDIT.POINTS');
        expect(body).toContain('BILLING.CREDIT.CASH_EQUIVALENT');
    });

    it('says what will be left afterwards, before the press', () => {
        setup({balance: 500});

        expect(text()).toContain('BILLING.CREDIT.PURCHASE.LEAVES');
    });

    /** A confirm button that always 400s is worse than one that is not there. */
    it('refuses to submit a spend the balance cannot cover', () => {
        const {fixture, buy} = setup({balance: 100});

        expect(text()).toContain('BILLING.CREDIT.NOT_ENOUGH');
        expect(button('BILLING.CREDIT.PURCHASE.CONFIRM').disabled).toBe(true);

        fixture.componentInstance['confirm']();
        expect(buy).not.toHaveBeenCalled();
    });
});

describe('spending the credit', () => {
    it('sends the SKU and points a guild purchase at the guild', () => {
        const {fixture, buy} = setup({subject: {kind: 'guild', id: 'gld_1'}});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(buy).toHaveBeenCalledTimes(1);
        expect(buy.mock.calls[0][0].sku).toBe('guild_pro_30d');
        expect(buy.mock.calls[0][0].targetId).toBe('gld_1');
    });

    /** A user SKU is always applied to the buyer; naming a target would be the server guessing. */
    it('sends no target for a purchase on the reader own account', () => {
        const {fixture, buy} = setup({subject: MY_ENTITLEMENTS, sku: sku({subject: 'User'})});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(buy.mock.calls[0][0].targetId).toBeNull();
    });

    it('re-reads the ceilings the grant just moved, and says the thing is active', () => {
        const subject: EntitlementSubjectRef = {kind: 'guild', id: 'gld_1'};
        const {fixture, invalidate, ensureLoaded, emitted} = setup({subject});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(text()).toContain('BILLING.CREDIT.PURCHASE.ACTIVE_TITLE');
        expect(invalidate).toHaveBeenCalledWith(subject);
        expect(ensureLoaded).toHaveBeenCalledWith(subject);
        expect(emitted).toHaveLength(1);
    });

    it('cannot be fired twice while the first spend is still in flight', () => {
        const inFlight = new Subject<CreditPurchaseDto>();
        const {fixture, buy} = setup({inFlight});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();
        fixture.componentInstance['confirm']();

        expect(buy).toHaveBeenCalledTimes(1);
    });
});

describe('a purchase that queues behind what is already held', () => {
    /**
     * The worst support ticket in the specification, avoided. Thirty days of Pro on a guild that is
     * Pro until the 30th starts on the 30th, and a screen that implied it was live now is how "I
     * spent my credit and got nothing" arrives.
     */
    it('names the day it starts rather than implying it took effect now', () => {
        const {fixture} = setup({
            result: purchase({
                wasQueued: true,
                startsAt: '2026-09-30T00:00:00Z',
                expiresAt: '2026-10-30T00:00:00Z',
            }),
        });

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        const body = text();
        expect(body).toContain('BILLING.CREDIT.PURCHASE.QUEUED_TITLE');
        expect(body).toContain('BILLING.CREDIT.PURCHASE.QUEUED_BODY');
        expect(body).not.toContain('BILLING.CREDIT.PURCHASE.ACTIVE_TITLE');
    });

    it('says it is active, and only then, for a purchase that started immediately', () => {
        const {fixture} = setup({result: purchase({wasQueued: false})});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(text()).toContain('BILLING.CREDIT.PURCHASE.ACTIVE_TITLE');
        expect(text()).not.toContain('BILLING.CREDIT.PURCHASE.QUEUED_TITLE');
    });
});

describe('a refused spend', () => {
    /**
     * The refusal for a plan already held permanently says, in the server's own words, that nothing
     * was charged. That is the first thing somebody needs, and no table on this side could say it.
     */
    it('shows the service own sentence rather than a generic failure', () => {
        const {fixture, emitted, invalidate} = setup({
            error: new HttpErrorResponse({
                status: 400,
                error: {
                    code: 'already_permanent',
                    message: "guild gld_1 already holds 'pro' with no end date. Nothing has been charged.",
                },
            }),
        });

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        const body = text();
        expect(body).toContain('Nothing has been charged.');
        expect(body).not.toContain('BILLING.CREDIT.ERROR.GENERIC');
        expect(body).not.toContain('already_permanent');
        expect(body).not.toContain('400');
        // Nothing moved, so nothing is re-read as though it had.
        expect(emitted).toHaveLength(0);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('apologises in our own words for a failure that carried no sentence', () => {
        const {fixture} = setup({error: new HttpErrorResponse({status: 500})});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(text()).toContain('BILLING.CREDIT.ERROR.GENERIC');
    });

    it('leaves the dialog open with a retry rather than closing on the refusal', () => {
        const {fixture} = setup({error: new HttpErrorResponse({status: 500})});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(() => button('BILLING.CREDIT.PURCHASE.RETRY')).not.toThrow();
    });
});

describe('the idempotency key', () => {
    /**
     * The whole point of the key. A retry after a dropped connection has to replay the first
     * purchase, and a key minted per press would make it a second one at full price - while looking
     * exactly as correct from the button.
     */
    it('is the same across two submits from one dialog', () => {
        const {fixture, buy} = setup({failFirst: true});

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();
        button('BILLING.CREDIT.PURCHASE.RETRY').click();
        fixture.detectChanges();

        const keys = keysUsed(buy);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).toBeTruthy();
    });

    /** Closing and opening again is somebody deciding to buy a second one, and it must go through. */
    it('is different across two dialogs', () => {
        const {fixture, buy} = setup();

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        reopen(fixture);

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        const keys = keysUsed(buy);
        expect(keys).toHaveLength(2);
        expect(keys[0]).not.toBe(keys[1]);
    });

    it('is always sent, because a purchase without one is refused outright', () => {
        const {fixture, buy} = setup();

        button('BILLING.CREDIT.PURCHASE.CONFIRM').click();
        fixture.detectChanges();

        expect(keysUsed(buy)[0]).toMatch(/^[0-9a-f-]{36}$/i);
    });
});
