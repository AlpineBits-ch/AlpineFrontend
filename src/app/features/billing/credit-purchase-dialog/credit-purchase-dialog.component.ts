import {Component, computed, effect, inject, input, model, output, signal, untracked} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {CreditPurchaseDto, CreditSkuDto} from '../../../dtos/response/credit.dto';
import {CreditService} from '../../../services/credit.service';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {creditErrorCopy, creditPurchaseCopy, newIdempotencyKey} from '../../../core/credit-copy';
import {formatMinor} from '../../../core/money';

/** Where the spend is. `refused` is not a dead end - the same key is retried from there. */
type PurchaseStep = 'confirm' | 'buying' | 'done' | 'refused';

/** Spending credit on one SKU. */
@Component({
    selector: 'app-credit-purchase-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    templateUrl: './credit-purchase-dialog.component.html',
})
export class CreditPurchaseDialogComponent {
    readonly visible = model.required<boolean>();
    readonly sku = input.required<CreditSkuDto>();
    readonly subject = input.required<EntitlementSubjectRef>();
    /** The wallet balance the catalogue was read with, for the "left after this" line. */
    readonly balance = input.required<number>();
    /** The section 8.1 sentence, already resolved to a key or to the server's text. */
    readonly disclaimer = input<{key: string | null; text: string | null} | null>(null);

    /** Emitted on a completed spend, so the wallet and the catalogue behind this can be re-read. */
    purchased = output<CreditPurchaseDto>();

    private credit = inject(CreditService);
    private entitlements = inject(EntitlementStore);

    protected readonly step = signal<PurchaseStep>('confirm');
    protected readonly result = signal<CreditPurchaseDto | null>(null);
    /** Our sentence, or null when {@link errorText} carries the server's. */
    protected readonly errorKey = signal<string | null>(null);
    protected readonly errorText = signal<string | null>(null);

    /** The key this dialog's purchase is made under. */
    private idempotencyKey = newIdempotencyKey();

    protected readonly cash = computed(() => {
        const sku = this.sku();
        return sku.cashPriceMinorUnits === null || sku.cashCurrency === null
            ? null
            : formatMinor(sku.cashPriceMinorUnits, sku.cashCurrency);
    });

    /** What is left afterwards. Shown before the press, because it is the question people ask. */
    protected readonly balanceAfter = computed(() => this.balance() - this.sku().pricePoints);

    protected readonly affordable = computed(() => this.balanceAfter() >= 0);

    protected readonly busy = computed(() => this.step() === 'buying');

    protected readonly outcome = computed(() => {
        const purchase = this.result();
        return purchase ? creditPurchaseCopy(purchase) : null;
    });

    constructor() {
        // Opening mints the key and clears the last attempt. Closing resets, so a second purchase
        // of the same SKU is a second purchase rather than a replay of the first.
        effect(() => {
            const open = this.visible();
            untracked(() => {
                this.reset();
                if (open) this.idempotencyKey = newIdempotencyKey();
            });
        });
    }

    /** Spends the credit, or retries the same spend. */
    protected confirm(): void {
        if (this.busy() || !this.affordable()) return;

        this.step.set('buying');
        this.errorKey.set(null);
        this.errorText.set(null);

        this.credit
            .purchase({
                sku: this.sku().code,
                targetId: this.targetId(),
                idempotencyKey: this.idempotencyKey,
            })
            .subscribe({
                next: purchase => {
                    this.result.set(purchase);
                    this.step.set('done');

                    // Even a queued grant moves the subject's grant set, and the server announces it.
                    // Dropping the snapshot is what stops the ceilings screen answering from a set
                    // fetched before the purchase for the whole of its TTL.
                    const subject = this.subject();
                    this.entitlements.invalidate(subject);
                    this.entitlements.ensureLoaded(subject);

                    this.purchased.emit(purchase);
                },
                error: err => {
                    const copy = creditErrorCopy(err);
                    this.errorKey.set(copy.key);
                    this.errorText.set(copy.text);
                    this.step.set('refused');
                },
            });
    }

    /** Closes, unless a spend is in flight. Leaving mid-request is how a purchase goes unreported. */
    protected close(): void {
        if (this.busy()) return;
        this.visible.set(false);
    }

    protected onVisibleChange(visible: boolean): void {
        if (visible) {
            this.visible.set(true);
            return;
        }
        this.close();
    }

    /** The guild a guild SKU applies to, or null so the server applies a user SKU to the buyer. */
    private targetId(): string | null {
        const subject = this.subject();
        return subject.kind === 'guild' ? subject.id : null;
    }

    private reset(): void {
        this.step.set('confirm');
        this.result.set(null);
        this.errorKey.set(null);
        this.errorText.set(null);
    }
}
