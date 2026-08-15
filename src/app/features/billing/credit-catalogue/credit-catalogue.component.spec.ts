import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import en from '../../../../assets/i18n/locales/en.json';
import {CreditCatalogueComponent} from './credit-catalogue.component';
import {CreditService} from '../../../services/credit.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {CreditCatalogueDto, CreditSkuDto} from '../../../dtos/response/credit.dto';
import {formatMinor} from '../../../core/money';

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

function catalogue(over: Partial<CreditCatalogueDto> = {}): CreditCatalogueDto {
    return {
        balance: 500,
        skus: [sku()],
        disclaimer: 'Credits have no cash value and expire.',
        disclaimerKey: 'credit.disclaimer',
        ...over,
    };
}

function setup(opts: {
    subject?: EntitlementSubjectRef;
    catalogue?: CreditCatalogueDto;
    error?: unknown;
    /**
     * Loads the real English copy, so a test can read the interpolated sentence rather than the
     * key. Off by default: every other assertion in this file reads against the key, which is what
     * an unloaded locale renders.
     */
    translated?: boolean;
} = {}) {
    const getCatalogue = vi.fn<() => Observable<CreditCatalogueDto>>(() => opts.error
        ? throwError(() => opts.error)
        : of(opts.catalogue ?? catalogue()));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [CreditCatalogueComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: CreditService, useValue: {getCatalogue, purchase: vi.fn()}},
            {provide: EntitlementStore, useValue: {invalidate: vi.fn(), ensureLoaded: vi.fn()}},
        ],
    });

    if (opts.translated) {
        const translate = TestBed.inject(TranslateService);
        translate.setTranslation('en', en);
        translate.use('en');
    }

    const fixture: ComponentFixture<CreditCatalogueComponent> =
        TestBed.createComponent(CreditCatalogueComponent);
    fixture.componentRef.setInput('subject', opts.subject ?? {kind: 'guild', id: 'gld_1'});
    fixture.detectChanges();

    return {fixture, getCatalogue};
}

function text(fixture: ComponentFixture<CreditCatalogueComponent>): string {
    return fixture.nativeElement.textContent as string;
}

function hasButton(fixture: ComponentFixture<CreditCatalogueComponent>, label: string): boolean {
    return Array.from(fixture.nativeElement.querySelectorAll('button'))
        .some(el => ((el as HTMLElement).textContent ?? '').includes(label));
}

describe('what credit buys', () => {
    it('draws both halves of the price on the same row', () => {
        const {fixture} = setup();
        const body = text(fixture);

        expect(body).toContain('30 days of Pro');
        expect(body).toContain('BILLING.CREDIT.POINTS');
        expect(body).toContain('BILLING.CREDIT.CASH_EQUIVALENT');
    });

    /**
     * Points are abstract by design, and section 8.2 says to show the cash price beside them so
     * nobody has to guess what a credit is worth. Read with the real copy loaded, because the
     * figures live inside the interpolation and an unloaded locale renders neither.
     */
    it('spells out both figures once the copy is in place', () => {
        const {fixture} = setup({translated: true});
        const body = text(fixture);

        expect(body).toContain('400 credits');
        expect(body).toContain(formatMinor(2900, 'usd'));
    });

    /**
     * The server withholds a SKU whose plan has no cash price, because credit must never be the
     * only route to something. A second filter here would be a copy of a decision already made.
     */
    it('renders what it was sent rather than re-applying the cash-price rule', () => {
        const {fixture} = setup({
            catalogue: catalogue({
                skus: [sku({cashPriceMinorUnits: null, cashCurrency: null, title: 'Unpriced thing'})],
            }),
        });

        expect(text(fixture)).toContain('Unpriced thing');
        expect(hasButton(fixture, 'BILLING.CREDIT.SPEND')).toBe(true);
    });

    /** A guild SKU has nowhere to go on an account screen, and the server would refuse it. */
    it('offers only the SKUs that match the screen subject', () => {
        const {fixture} = setup({
            subject: MY_ENTITLEMENTS,
            catalogue: catalogue({
                skus: [sku({code: 'g', title: 'Server Pro', subject: 'Guild'}),
                    sku({code: 'u', title: 'Venta Plus', subject: 'User'})],
            }),
        });

        expect(text(fixture)).toContain('Venta Plus');
        expect(text(fixture)).not.toContain('Server Pro');
    });

    /** The credit endpoints send PascalCase subject kinds; the checkout ones send lowercase. */
    it('is not thrown by the casing the credit endpoints use', () => {
        const {fixture} = setup({
            subject: {kind: 'guild', id: 'gld_1'},
            catalogue: catalogue({skus: [sku({subject: 'Guild', title: 'Server Pro'})]}),
        });

        expect(text(fixture)).toContain('Server Pro');
    });

    /** A balance fifty points short should show what it is short of, not hide the row. */
    it('lists a SKU the balance cannot reach without a button on it', () => {
        const {fixture} = setup({catalogue: catalogue({balance: 100})});

        expect(text(fixture)).toContain('30 days of Pro');
        expect(text(fixture)).toContain('BILLING.CREDIT.NOT_ENOUGH');
        expect(hasButton(fixture, 'BILLING.CREDIT.SPEND')).toBe(false);
    });

    it('says there is nothing to buy rather than drawing an empty list', () => {
        const {fixture} = setup({catalogue: catalogue({skus: []})});

        expect(text(fixture)).toContain('BILLING.CREDIT.NOTHING_TO_BUY');
    });
});

describe('an instance with no credit', () => {
    it('removes the whole section on a 404', () => {
        const {fixture} = setup({error: new HttpErrorResponse({status: 404})});

        expect(text(fixture).trim()).toBe('');
    });

    /** A catalogue that would not load is not a catalogue with nothing in it. */
    it('keeps the section and offers a retry for any other failure', () => {
        const {fixture, getCatalogue} = setup({error: new HttpErrorResponse({status: 500})});

        expect(text(fixture)).toContain('BILLING.CREDIT.SPEND_SECTION');
        expect(text(fixture)).not.toContain('BILLING.CREDIT.NOTHING_TO_BUY');

        const retry = Array.from(fixture.nativeElement.querySelectorAll('button'))
            .find(el => ((el as HTMLElement).textContent ?? '').includes('BILLING.CREDIT.RETRY'));
        (retry as HTMLElement).click();
        fixture.detectChanges();

        expect(getCatalogue).toHaveBeenCalledTimes(2);
    });
});
