import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, Subject, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {PaymentMethodsComponent} from './payment-methods.component';
import {BillingService} from '../../../services/billing.service';
import {PaymentMethodDto} from '../../../dtos/response/billing.dto';

function card(over: Partial<PaymentMethodDto> = {}): PaymentMethodDto {
    return {id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true, ...over};
}

function setup(
    opts: {
        cards?: PaymentMethodDto[];
        listError?: unknown;
        detachError?: unknown;
        /** A detach that never answers, for the double-submit case. */
        detachInFlight?: Subject<void>;
    } = {},
) {
    const list = vi.fn<() => Observable<PaymentMethodDto[]>>(() =>
        opts.listError ? throwError(() => opts.listError) : of(opts.cards ?? [card()]),
    );
    const setDefault = vi.fn<(id: string) => Observable<void>>(() => of(undefined));
    const remove = vi.fn<(id: string) => Observable<void>>(() => {
        if (opts.detachInFlight) return opts.detachInFlight.asObservable();
        return opts.detachError ? throwError(() => opts.detachError) : of(undefined);
    });

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

/** Untranslated keys render as themselves, so assertions read against the key. */
function text(_fixture: ComponentFixture<PaymentMethodsComponent>): string {
    return document.body.textContent ?? '';
}

/** Just the confirmation's own text. */
function dialogText(): string {
    return document.body.querySelector('.p-dialog')?.textContent ?? '';
}

function buttons(label: string): HTMLButtonElement[] {
    return Array.from(document.body.querySelectorAll('button')).filter(el =>
        ((el as HTMLElement).textContent ?? '').includes(label),
    ) as HTMLButtonElement[];
}

function button(_fixture: ComponentFixture<PaymentMethodsComponent>, label: string): HTMLElement {
    const found = buttons(label)[0];
    if (!found) throw new Error(`no button containing ${label}`);
    return found;
}

/** Presses Remove on one row and then the confirmation, which is the whole of the detach path. */
function removeCard(fixture: ComponentFixture<PaymentMethodsComponent>, row = 0): void {
    buttons('BILLING.CARD.REMOVE')[row].click();
    fixture.detectChanges();
    button(fixture, 'BILLING.CARDS.REMOVE_CONFIRM').click();
    fixture.detectChanges();
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

        removeCard(fixture);

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

        removeCard(fixture);

        expect(text(fixture)).toContain('BILLING.ERROR.LAST_PAYMENT_METHOD');
        expect(text(fixture)).not.toContain('409');
    });

    it('degrades a refusal this build has no sentence for rather than showing the code', () => {
        const {fixture} = setup({
            cards: [card()],
            detachError: new HttpErrorResponse({status: 409, error: {code: 'card_in_dispute'}}),
        });

        removeCard(fixture);

        expect(text(fixture)).toContain('BILLING.ERROR.GENERIC');
        expect(text(fixture)).not.toContain('card_in_dispute');
    });
});

/** The confirmation, which is about the consequence rather than the click. */
describe('confirming a removal', () => {
    it('asks first and detaches nothing until the confirmation is pressed', () => {
        const {fixture, remove} = setup({cards: [card()]});

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.CARDS.REMOVE_TITLE');
        expect(remove).not.toHaveBeenCalled();
    });

    /** "Remove this card?" over a dialog naming none of them is a coin toss on an account with three. */
    it('names the card it is about, not merely a card', () => {
        const {fixture} = setup({
            cards: [card(), card({id: 'pm_2', brand: 'cartes_bancaires', last4: '5454', isDefault: false})],
        });

        buttons('BILLING.CARD.REMOVE')[1].click();
        fixture.detectChanges();

        expect(dialogText()).toContain('BILLING.CARD.LINE_UNKNOWN');
    });

    /** The one that cannot be shrugged off: with no card on file there is nothing left to charge. */
    it('says so when the card being removed is the only one', () => {
        const {fixture} = setup({cards: [card()]});

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.CARDS.REMOVE_BODY_ONLY');
        expect(text(fixture)).not.toContain('BILLING.CARDS.REMOVE_BODY_DEFAULT');
    });

    it('says so when the card being removed is the one that pays', () => {
        const {fixture} = setup({
            cards: [card(), card({id: 'pm_2', last4: '5454', isDefault: false})],
        });

        buttons('BILLING.CARD.REMOVE')[0].click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.CARDS.REMOVE_BODY_DEFAULT');
        expect(text(fixture)).not.toContain('BILLING.CARDS.REMOVE_BODY_ONLY');
    });

    /** Neither consequence applies, and inventing one would be a warning about nothing. */
    it('says only that it comes off the account for a spare card', () => {
        const {fixture} = setup({
            cards: [card(), card({id: 'pm_2', last4: '5454', isDefault: false})],
        });

        buttons('BILLING.CARD.REMOVE')[1].click();
        fixture.detectChanges();

        expect(text(fixture)).toContain('BILLING.CARDS.REMOVE_BODY');
        expect(text(fixture)).not.toContain('BILLING.CARDS.REMOVE_BODY_ONLY');
        expect(text(fixture)).not.toContain('BILLING.CARDS.REMOVE_BODY_DEFAULT');
    });

    it('keeps the card when the confirmation is declined, and calls nothing', () => {
        const {fixture, remove} = setup({cards: [card()]});

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();
        button(fixture, 'BILLING.CARDS.REMOVE_KEEP').click();
        fixture.detectChanges();

        expect(remove).not.toHaveBeenCalled();
        // The body, not the header: PrimeNG animates the dialog out, so the header survives one
        // more cycle. What has to be gone is the thing that was being confirmed.
        expect(text(fixture)).not.toContain('BILLING.CARDS.REMOVE_BODY');
    });

    /** A card detached twice is a second 404 and a list that reloads over itself. */
    it('cannot be confirmed twice while the first detach is still in flight', () => {
        const inFlight = new Subject<void>();
        const {fixture, remove} = setup({cards: [card()], detachInFlight: inFlight});

        button(fixture, 'BILLING.CARD.REMOVE').click();
        fixture.detectChanges();
        button(fixture, 'BILLING.CARDS.REMOVE_CONFIRM').click();
        fixture.detectChanges();
        button(fixture, 'BILLING.CARDS.REMOVE_CONFIRM').click();
        fixture.detectChanges();

        expect(remove).toHaveBeenCalledTimes(1);
    });
});
