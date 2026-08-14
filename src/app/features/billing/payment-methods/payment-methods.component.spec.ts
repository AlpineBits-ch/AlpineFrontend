import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {PaymentMethodsComponent} from './payment-methods.component';
import {BillingService} from '../../../services/billing.service';
import {PaymentMethodDto} from '../../../dtos/response/billing.dto';

function card(over: Partial<PaymentMethodDto> = {}): PaymentMethodDto {
    return {id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true, ...over};
}

function setup(opts: {
    cards?: PaymentMethodDto[];
    listError?: unknown;
    detachError?: unknown;
} = {}) {
    const list = vi.fn<() => Observable<PaymentMethodDto[]>>(() => opts.listError
        ? throwError(() => opts.listError)
        : of(opts.cards ?? [card()]));
    const setDefault = vi.fn<(id: string) => Observable<void>>(() => of(undefined));
    const remove = vi.fn<(id: string) => Observable<void>>(() => opts.detachError
        ? throwError(() => opts.detachError)
        : of(undefined));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [PaymentMethodsComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {
                provide: BillingService,
                useValue: {
                    listPaymentMethods: list,
                    setDefaultPaymentMethod: setDefault,
                    deletePaymentMethod: remove,
                    createSetupIntent: () => of({clientSecret: 'seti_1_secret_x'}),
                },
            },
        ],
    });

    const fixture: ComponentFixture<PaymentMethodsComponent> =
        TestBed.createComponent(PaymentMethodsComponent);
    fixture.detectChanges();
    return {fixture, list, setDefault, remove};
}

function text(fixture: ComponentFixture<PaymentMethodsComponent>): string {
    return fixture.nativeElement.textContent as string;
}

function button(fixture: ComponentFixture<PaymentMethodsComponent>, label: string): HTMLElement {
    const found = Array.from(fixture.nativeElement.querySelectorAll('button'))
        .find(el => ((el as HTMLElement).textContent ?? '').includes(label));
    if (!found) throw new Error(`no button containing ${label}`);
    return found as HTMLElement;
}

describe('the cards on file', () => {
    /** Brand, last four and expiry are the whole of the card data on our side, by design. */
    it('names the brand, the last four and the expiry, and marks the default', () => {
        const {fixture} = setup({cards: [card()]});

        expect(text(fixture)).toContain('BILLING.CARD.LINE');
        expect(text(fixture)).toContain('BILLING.CARD.EXPIRES');
        expect(text(fixture)).toContain('BILLING.CARD.DEFAULT');
    });

    /** A brand nobody here has heard of gets a sentence with no brand in it, not a raw token. */
    it('falls back to a brandless line for a brand this build does not know', () => {
        const {fixture} = setup({cards: [card({brand: 'cartes_bancaires'})]});

        expect(text(fixture)).toContain('BILLING.CARD.LINE_UNKNOWN');
        expect(text(fixture)).not.toContain('cartes_bancaires');
    });

    it('uses the spelling the brand itself uses where it knows it', () => {
        const {fixture} = setup({cards: [card({brand: 'mastercard'})]});

        expect(text(fixture)).toContain('BILLING.CARD.LINE');
        expect(text(fixture)).not.toContain('BILLING.CARD.LINE_UNKNOWN');
    });

    it('says there is no card rather than nothing at all on an empty account', () => {
        const {fixture} = setup({cards: []});

        expect(text(fixture)).toContain('BILLING.CARDS.NONE');
    });

    /**
     * A failed read is not an empty list. "You have no cards" invites somebody to add a second
     * copy of the card that is already on file.
     */
    it('separates a list that would not load from an account with no cards', () => {
        const {fixture} = setup({listError: new HttpErrorResponse({status: 500})});

        expect(text(fixture)).toContain('BILLING.CARDS.LOAD_FAILED');
        expect(text(fixture)).not.toContain('BILLING.CARDS.NONE');
    });
});

describe('changing which card pays', () => {
    it('sets the default and re-reads the list rather than reordering it here', () => {
        const {fixture, setDefault, list} = setup({
            cards: [card(), card({id: 'pm_2', brand: 'mastercard', last4: '5454', isDefault: false})],
        });

        button(fixture, 'BILLING.CARD.MAKE_DEFAULT').click();
        fixture.detectChanges();

        expect(setDefault).toHaveBeenCalledWith('pm_2');
        expect(list).toHaveBeenCalledTimes(2);
    });

    it('offers no such button against the card that already pays', () => {
        const {fixture} = setup({cards: [card()]});

        expect(text(fixture)).not.toContain('BILLING.CARD.MAKE_DEFAULT');
    });
});

describe('removing a card', () => {
    it('detaches the one that was asked for and re-reads the list', () => {
        const {fixture, remove, list} = setup({cards: [card()]});

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();

        expect(remove).toHaveBeenCalledWith('pm_1');
        expect(list).toHaveBeenCalledTimes(2);
    });

    /**
     * The refusal that matters. Stripe would otherwise accept the detach and fail the next
     * invoice, which turns a refusable action into a support ticket a month later - so this has to
     * read as a sentence about what to do, never as "409".
     */
    it('explains what to do when the last card under a live subscription is refused', () => {
        const {fixture} = setup({
            cards: [card()],
            detachError: new HttpErrorResponse({status: 409, error: {code: 'last_payment_method'}}),
        });

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.ERROR.LAST_PAYMENT_METHOD');
        expect(text(fixture)).not.toContain('409');
    });

    it('degrades a refusal this build has no sentence for rather than showing the code', () => {
        const {fixture} = setup({
            cards: [card()],
            detachError: new HttpErrorResponse({status: 409, error: {code: 'card_in_dispute'}}),
        });

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.ERROR.GENERIC');
        expect(text(fixture)).not.toContain('card_in_dispute');
    });
});
