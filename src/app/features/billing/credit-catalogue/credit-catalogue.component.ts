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

/** What credit buys here, in points and in cash side by side. */
@Component({
    selector: 'app-credit-catalogue',
    imports: [TranslateModule, CreditPurchaseDialogComponent],
    templateUrl: './credit-catalogue.component.html',
})
export class CreditCatalogueComponent {
    readonly subject = input.required<EntitlementSubjectRef>();

    /** Emitted on a completed spend, so the wallet above this can be re-read. */
    purchased = output<CreditPurchaseDto>();

    private credit = inject(CreditService);
    private translate = inject(TranslateService);

    protected readonly catalogue = signal<CreditCatalogueDto | null>(null);
    protected readonly loading = signal(true);
    /** Set on a 404, which is this instance saying credit does not exist here at all. */
    protected readonly absent = signal(false);
    protected readonly loadErrorKey = signal<string | null>(null);
    protected readonly loadErrorText = signal<string | null>(null);

    protected readonly chosen = signal<CreditSkuDto | null>(null);
    protected readonly purchaseVisible = signal(false);

    protected readonly skeletonRows = [1, 2];

    protected readonly balance = computed(() => this.catalogue()?.balance ?? 0);

    /** The disclaimer, preferring the server's key only where this build has the string. */
    protected readonly disclaimer = computed(() => {
        const catalogue = this.catalogue();
        return creditDisclaimerCopy(catalogue?.disclaimer, catalogue?.disclaimerKey, key =>
            this.resolves(key),
        );
    });

    protected readonly rows = computed<SkuRow[]>(() => {
        const subject = this.subject();
        const balance = this.balance();

        return (this.catalogue()?.skus ?? [])
            .filter(sku => sameSubjectKind(sku.subject, subject.kind))
            .map(sku => ({
                sku,
                cash:
                    sku.cashPriceMinorUnits === null || sku.cashCurrency === null
                        ? null
                        : formatMinor(sku.cashPriceMinorUnits, sku.cashCurrency),
                affordable: balance >= sku.pricePoints,
            }));
    });

    /** Read once, not per subject. */
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
