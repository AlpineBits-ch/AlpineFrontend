import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Observable, of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {CreditPanelComponent} from './credit-panel.component';
import {CreditService} from '../../../services/credit.service';
import {EntitlementStore, EntitlementSubjectRef, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';
import {
    CreditCatalogueDto,
    CreditLedgerDto,
    CreditLotDto,
    CreditWalletDto,
} from '../../../dtos/response/credit.dto';
import {CREDIT_EXPIRY_WARNING_DAYS} from '../../../core/credit-copy';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): string {
    return new Date(Date.now() + days * DAY_MS).toISOString();
}

function lot(over: Partial<CreditLotDto> = {}): CreditLotDto {
    return {
        lotId: 'lot_1',
        points: 500,
        originalPoints: 500,
        expiresAt: daysFromNow(200),
        campaignId: null,
        ...over,
    };
}

function wallet(over: Partial<CreditWalletDto> = {}): CreditWalletDto {
    return {
        userId: 'usr_9',
        balance: 500,
        capPoints: 10000,
        lots: [lot()],
        disclaimer: 'Credits have no cash value and expire.',
        disclaimerKey: 'credit.disclaimer',
        ...over,
    };
}

function catalogue(over: Partial<CreditCatalogueDto> = {}): CreditCatalogueDto {
    return {
        balance: 500,
        skus: [],
        disclaimer: 'Credits have no cash value and expire.',
        disclaimerKey: 'credit.disclaimer',
        ...over,
    };
}

function ledger(over: Partial<CreditLedgerDto> = {}): CreditLedgerDto {
    return {
        userId: 'usr_9',
        balance: 500,
        entries: [],
        disclaimer: 'Credits have no cash value and expire.',
        disclaimerKey: 'credit.disclaimer',
        ...over,
    };
}

function setup(
    opts: {
        subject?: EntitlementSubjectRef;
        wallet?: CreditWalletDto;
        walletError?: unknown;
        catalogue?: CreditCatalogueDto;
        catalogueError?: unknown;
        ledger?: CreditLedgerDto;
    } = {},
) {
    const getWallet = vi.fn<() => Observable<CreditWalletDto>>(() =>
        opts.walletError ? throwError(() => opts.walletError) : of(opts.wallet ?? wallet()),
    );

    const getCatalogue = vi.fn<() => Observable<CreditCatalogueDto>>(() =>
        opts.catalogueError ? throwError(() => opts.catalogueError) : of(opts.catalogue ?? catalogue()),
    );

    const getLedger = vi.fn<() => Observable<CreditLedgerDto>>(() => of(opts.ledger ?? ledger()));

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [CreditPanelComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: CreditService, useValue: {getWallet, getCatalogue, getLedger, purchase: vi.fn()}},
            {provide: EntitlementStore, useValue: {invalidate: vi.fn(), ensureLoaded: vi.fn()}},
        ],
    });

    const fixture: ComponentFixture<CreditPanelComponent> = TestBed.createComponent(CreditPanelComponent);
    fixture.componentRef.setInput('subject', opts.subject ?? MY_ENTITLEMENTS);
    fixture.detectChanges();

    return {fixture, getWallet, getCatalogue, getLedger};
}

/** Untranslated keys render as themselves, so assertions read against the key. */
function text(fixture: ComponentFixture<CreditPanelComponent>): string {
    return fixture.nativeElement.textContent as string;
}

describe('the balance', () => {
    it('names what the reader holds and when the parcel it is in lapses', () => {
        const {fixture} = setup({
            wallet: wallet({balance: 750, lots: [lot({points: 750, expiresAt: daysFromNow(200)})]}),
        });
        const body = text(fixture);

        expect(body).toContain('BILLING.CREDIT.SECTION');
        expect(body).toContain('BILLING.CREDIT.BALANCE_LABEL');
        expect(body).toContain('BILLING.CREDIT.POINTS');
        expect(body).toContain('BILLING.CREDIT.EXPIRES_ON');
    });

    /**
     * A date on its own asks the reader to do arithmetic they will not do until the credit is gone,
     * so a lot inside the window says so in words.
     */
    it('calls out a lot inside the warning window', () => {
        const {fixture} = setup({
            wallet: wallet({lots: [lot({expiresAt: daysFromNow(CREDIT_EXPIRY_WARNING_DAYS - 2)})]}),
        });

        expect(text(fixture)).toContain('BILLING.CREDIT.EXPIRING_SOON');
    });

    it('says nothing of the sort about a lot with months left on it', () => {
        const {fixture} = setup({
            wallet: wallet({lots: [lot({expiresAt: daysFromNow(CREDIT_EXPIRY_WARNING_DAYS + 10)})]}),
        });

        expect(text(fixture)).toContain('BILLING.CREDIT.EXPIRES_ON');
        expect(text(fixture)).not.toContain('BILLING.CREDIT.EXPIRING_SOON');
    });

    /** Somebody at the cap who does not know it reads the next campaign that skips them as a bug. */
    it('says when the wallet is full', () => {
        const {fixture} = setup({wallet: wallet({balance: 10000, capPoints: 10000})});

        expect(text(fixture)).toContain('BILLING.CREDIT.AT_CAP');
    });

    it('says nothing about a cap nobody is near', () => {
        const {fixture} = setup({wallet: wallet({balance: 100, capPoints: 10000})});

        expect(text(fixture)).not.toContain('BILLING.CREDIT.AT_CAP');
    });
});

describe('the disclaimer', () => {
    /**
     * Required wherever a balance is displayed. The test bed loads no locale, so the server key does
     * not resolve here - which is exactly the fallback path, and it renders the server's sentence
     * rather than the raw key.
     */
    it('is beside the balance, and is never a raw key', () => {
        const {fixture} = setup({
            wallet: wallet({
                disclaimer: 'Credits are promotional and expire.',
                disclaimerKey: 'credit.disclaimer',
            }),
        });

        expect(text(fixture)).toContain('Credits are promotional and expire.');
        expect(text(fixture)).not.toContain('credit.disclaimer');
    });

    it('falls back to its own sentence when the server sent neither', () => {
        const {fixture} = setup({wallet: wallet({disclaimer: '', disclaimerKey: ''})});

        expect(text(fixture)).toContain('BILLING.CREDIT.DISCLAIMER');
    });
});

describe('an instance with no credit at all', () => {
    /**
     * The distinction the whole section turns on. A 404 is how a self-hosted instance says credit
     * does not exist here; everything already resolves to its maximum there, so a wallet is
     * meaningless and a zero balance reads as a bug and gets reported as one.
     */
    it('removes the section entirely on a 404 rather than rendering a zero', () => {
        const {fixture} = setup({
            walletError: new HttpErrorResponse({status: 404}),
            catalogueError: new HttpErrorResponse({status: 404}),
        });
        const body = text(fixture);

        expect(body).not.toContain('BILLING.CREDIT.SECTION');
        expect(body).not.toContain('BILLING.CREDIT.BALANCE_LABEL');
        expect(body).not.toContain('BILLING.CREDIT.POINTS');
        expect(body).not.toContain('BILLING.CREDIT.SPEND_SECTION');
        expect(body.trim()).toBe('');
    });

    /**
     * The other half of the same distinction. A balance that exists and would not load is not a
     * balance that does not exist, so the section stays and apologises.
     */
    it('keeps the section and offers a retry for a read that merely failed', () => {
        const {fixture, getWallet} = setup({
            walletError: new HttpErrorResponse({status: 500}),
        });

        expect(text(fixture)).toContain('BILLING.CREDIT.SECTION');
        expect(text(fixture)).toContain('BILLING.CREDIT.ERROR.GENERIC');

        const retry = Array.from(fixture.nativeElement.querySelectorAll('button')).find(el =>
            ((el as HTMLElement).textContent ?? '').includes('BILLING.CREDIT.RETRY'),
        );
        (retry as HTMLElement).click();
        fixture.detectChanges();

        expect(getWallet).toHaveBeenCalledTimes(2);
    });
});

describe('whose screen this is', () => {
    /** The ledger is the reader's personal history, not something to show on a server they run. */
    it('keeps the history off a guild plan page', () => {
        const {fixture, getLedger} = setup({subject: {kind: 'guild', id: 'gld_1'}});

        expect(text(fixture)).not.toContain('BILLING.CREDIT.HISTORY_SECTION');
        expect(getLedger).not.toHaveBeenCalled();
    });

    it('shows it on the reader own account page', () => {
        const {fixture, getLedger} = setup({subject: MY_ENTITLEMENTS});

        expect(text(fixture)).toContain('BILLING.CREDIT.HISTORY_SECTION');
        expect(getLedger).toHaveBeenCalled();
    });
});
