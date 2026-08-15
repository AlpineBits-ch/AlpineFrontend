import {Component, computed, inject, input, output, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {sameSubjectKind} from '../../../dtos/response/billing.dto';
import {CreditCatalogueDto, CreditPurchaseDto, CreditSkuDto} from '../../../dtos/response/credit.dto';
import {CreditService, creditIsAbsent} from '../../../services/credit.service';
import {EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {creditDisclaimerCopy, creditErrorCopy} from '../../../core/credit-copy';
import {formatMinor} from '../../../core/money';
import {CreditPurchaseDialogComponent} from '../credit-purchase-dialog/credit-purchase-dialog.component';

/** One SKU as the list renders it: what it is, what it costs twice over, and whether it is reachable. */
interface SkuRow {
    sku: CreditSkuDto;
    /** The cash price, in the SKU's own currency. Null only on a service that predates the rule. */
    cash: string | null;
    affordable: boolean;
}

/**
 * What credit buys here, in points and in cash side by side.
 *
 * <p><b>Nothing is filtered out for having no cash price.</b> The server already withholds those -
 * section 8.1 forbids credit being the only route to anything - so a second filter here would be a
 * copy of a decision that is already made, kept in a place that would not be updated when the rule
 * moved. What is selected on is the <i>subject</i>: a guild SKU has nowhere to go on an account
 * screen, and a user SKU applied to a guild is not a thing the server accepts.</p>
 *
 * <p>A SKU the balance cannot reach is listed and not pressable, rather than hidden. The point of
 * the catalogue is to say what the credit is for, and a balance that is short by fifty points should
 * show what it is short of.</p>
 */
@Component({
    selector: 'app-credit-catalogue',
    imports: [TranslateModule, CreditPurchaseDialogComponent],
    templateUrl: './credit-catalogue.component.html',
})
export class CreditCatalogueComponent {
    subject = input.required<EntitlementSubjectRef>();

    /** Emitted on a completed spend, so the wallet above this can be re-read. */
    purchased = output<CreditPurchaseDto>();

    private credit = inject(CreditService);
    private translate = inject(TranslateService);

    protected catalogue = signal<CreditCatalogueDto | null>(null);
    protected loading = signal(true);
    /**
     * Set on a 404, which is this instance saying credit does not exist here at all.
     *
     * <p>Not an empty catalogue and not a zero balance. Both of those are statements about a wallet
     * that exists, and rendering either one where there is no wallet is what gets reported as a
     * defect on a self-hosted box.</p>
     */
    protected absent = signal(false);
    protected loadErrorKey = signal<string | null>(null);
    protected loadErrorText = signal<string | null>(null);

    protected chosen = signal<CreditSkuDto | null>(null);
    protected purchaseVisible = signal(false);

    protected readonly skeletonRows = [1, 2];

    protected balance = computed(() => this.catalogue()?.balance ?? 0);

    /**
     * The disclaimer, preferring the server's key only where this build has the string.
     *
     * <p>Read through `TranslateService` rather than against the bundled `en.json`, because the
     * active locale is what will actually be rendered: a key present in English and missing from the
     * reader's language would otherwise resolve here and render as the raw key to them.</p>
     */
    protected disclaimer = computed(() => {
        const catalogue = this.catalogue();
        return creditDisclaimerCopy(
            catalogue?.disclaimer, catalogue?.disclaimerKey, key => this.resolves(key));
    });

    protected rows = computed<SkuRow[]>(() => {
        const subject = this.subject();
        const balance = this.balance();

        return (this.catalogue()?.skus ?? [])
            .filter(sku => sameSubjectKind(sku.subject, subject.kind))
            .map(sku => ({
                sku,
                cash: sku.cashPriceMinorUnits === null || sku.cashCurrency === null
                    ? null
                    : formatMinor(sku.cashPriceMinorUnits, sku.cashCurrency),
                affordable: balance >= sku.pricePoints,
            }));
    });

    /**
     * Read once, not per subject.
     *
     * <p>The catalogue endpoint is caller-scoped and answers with everything on sale; which of
     * those SKUs belong on this screen is decided in {@link rows}, which reads `subject` and so
     * follows it without a second request.</p>
     */
    constructor() {
        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.loadErrorKey.set(null);
        this.loadErrorText.set(null);

        this.credit.getCatalogue().subscribe({
            next: catalogue => {
                this.catalogue.set(catalogue);
                this.absent.set(false);
                this.loading.set(false);
            },
            error: err => {
                if (creditIsAbsent(err)) {
                    this.absent.set(true);
                    this.loading.set(false);
                    return;
                }
                const copy = creditErrorCopy(err);
                this.loadErrorKey.set(copy.key);
                this.loadErrorText.set(copy.text);
                this.loading.set(false);
            },
        });
    }

    protected buy(sku: CreditSkuDto): void {
        this.chosen.set(sku);
        this.purchaseVisible.set(true);
    }

    /** The balance moved and the catalogue is priced against it, so it is read again. */
    protected onPurchased(purchase: CreditPurchaseDto): void {
        this.purchased.emit(purchase);
        this.load();
    }

    private resolves(key: string): boolean {
        const resolved = this.translate.instant(key);
        return typeof resolved === 'string' && resolved.length > 0 && resolved !== key;
    }
}
