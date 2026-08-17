import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {InvoiceListComponent} from './invoice-list.component';
import {BillingService} from '../../../services/billing.service';
import {LinkOpener} from '../../../platform/ports/link-opener.port';
import {FakeLinkOpener} from '../../../platform/testing/fake-link-opener';
import {InvoiceDto} from '../../../dtos/response/billing.dto';
import {formatMinor} from '../../../core/money';

function invoice(over: Partial<InvoiceDto> = {}): InvoiceDto {
    return {
        id: 'in_1',
        number: 'VENTA-0001',
        status: 'paid',
        amountDueMinorUnits: 2900,
        currency: 'usd',
        createdAt: '2026-08-14T10:12:00Z',
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/one',
        invoicePdfUrl: 'https://pay.stripe.com/i/one/pdf',
        ...over,
    };
}

function setup(opts: {invoices?: InvoiceDto[]; listError?: unknown} = {}) {
    const list = vi.fn<() => Observable<InvoiceDto[]>>(() =>
        opts.listError ? throwError(() => opts.listError) : of(opts.invoices ?? [invoice()]),
    );

    const opener = new FakeLinkOpener();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [InvoiceListComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: BillingService, useValue: {listInvoices: list}},
            // The real web adapter calls `window.open`, which would spawn tabs out of the runner.
            {provide: LinkOpener, useValue: opener},
        ],
    });

    const fixture: ComponentFixture<InvoiceListComponent> = TestBed.createComponent(InvoiceListComponent);
    fixture.detectChanges();
    return {fixture, list, opener};
}

function text(fixture: ComponentFixture<InvoiceListComponent>): string {
    return fixture.nativeElement.textContent as string;
}

function button(fixture: ComponentFixture<InvoiceListComponent>, label: string): HTMLElement {
    const found = Array.from(fixture.nativeElement.querySelectorAll('button')).find(el =>
        ((el as HTMLElement).textContent ?? '').includes(label),
    );
    if (!found) throw new Error(`no button containing ${label}`);
    return found as HTMLElement;
}

function hasButton(fixture: ComponentFixture<InvoiceListComponent>, label: string): boolean {
    try {
        button(fixture, label);
        return true;
    } catch {
        return false;
    }
}

describe('the receipts', () => {
    it('names the number, the date, the status and the amount', () => {
        const {fixture} = setup();
        const body = text(fixture);

        expect(body).toContain('VENTA-0001');
        expect(body).toContain('2026');
        expect(body).toContain('BILLING.INVOICE.STATUS.PAID');
        expect(body).toContain(formatMinor(2900, 'usd'));
    });

    /** Stripe's own word for a write-off is not one to put in front of somebody's own receipts. */
    it('never renders a raw provider status token', () => {
        const {fixture} = setup({invoices: [invoice({status: 'uncollectible'})]});

        expect(text(fixture)).toContain('BILLING.INVOICE.STATUS.UNCOLLECTIBLE');
        expect(text(fixture)).not.toContain('uncollectible');
    });

    it('has a word for a status this build has never seen', () => {
        const {fixture} = setup({invoices: [invoice({status: 'disputed'})]});

        expect(text(fixture)).toContain('BILLING.INVOICE.STATUS.OTHER');
        expect(text(fixture)).not.toContain('disputed');
    });

    /** A draft has no number yet, and a blank cell reads as a rendering fault. */
    it('says a number has not been issued rather than leaving a gap', () => {
        const {fixture} = setup({invoices: [invoice({number: '', status: 'draft'})]});

        expect(text(fixture)).toContain('BILLING.INVOICE.NO_NUMBER');
    });

    it('says there are none rather than nothing at all on a new account', () => {
        const {fixture} = setup({invoices: []});

        expect(text(fixture)).toContain('BILLING.INVOICES.NONE');
    });

    /**
     * A failed read is not an empty history. Telling somebody hunting for a receipt they have
     * already been charged for that there is nothing to find is the wrong answer.
     */
    it('separates a list that would not load from an account with no invoices', () => {
        const {fixture} = setup({listError: new HttpErrorResponse({status: 500})});

        expect(text(fixture)).toContain('BILLING.INVOICES.LOAD_FAILED');
        expect(text(fixture)).not.toContain('BILLING.INVOICES.NONE');
    });

    it('reads the list again when the retry is pressed', () => {
        const {fixture, list} = setup({listError: new HttpErrorResponse({status: 500})});

        button(fixture, 'BILLING.INVOICES.RETRY').click();
        fixture.detectChanges();

        expect(list).toHaveBeenCalledTimes(2);
    });
});

describe('opening an invoice', () => {
    /**
     * This app runs in a Tauri webview as well as a browser. A plain link there would replace the
     * running application with Stripe's page, and `window.open` does nothing at all - so both URLs
     * go through the platform opener, which is the only mechanism that works on both hosts.
     */
    it('hands the hosted page to the platform opener rather than navigating', () => {
        const {fixture, opener} = setup();

        button(fixture, 'BILLING.INVOICE.VIEW').click();

        expect(opener.opened).toEqual(['https://invoice.stripe.com/i/one']);
    });

    it('opens the PDF the same way', () => {
        const {fixture, opener} = setup();

        button(fixture, 'BILLING.INVOICE.PDF').click();

        expect(opener.opened).toEqual(['https://pay.stripe.com/i/one/pdf']);
    });

    /** A link that leads nowhere is worse than no link, so an absent URL gets no button. */
    it('draws no button for a URL the server did not send', () => {
        const {fixture} = setup({invoices: [invoice({invoicePdfUrl: ''})]});

        expect(hasButton(fixture, 'BILLING.INVOICE.VIEW')).toBe(true);
        expect(hasButton(fixture, 'BILLING.INVOICE.PDF')).toBe(false);
    });
});
