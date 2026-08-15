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

/**
 * Spending credit on one SKU.
 *
 * <p>Two things here are load-bearing and both are easy to get subtly wrong:</p>
 *
 * <ul>
 *   <li><b>The idempotency key is minted once, when the dialog opens.</b> Not per press. The whole
 *       value of the key is that a retry after a dropped connection replays the first purchase
 *       instead of making a second one at full price, and a key regenerated on submit throws that
 *       away while looking exactly as correct from here. Closing and reopening is a new key, because
 *       that is a person deciding to buy again.</li>
 *   <li><b>A queued purchase says when it starts.</b> Bought time queues behind what the subject
 *       already holds rather than overlapping it, so the response's `startsAt` can be a month out.
 *       Anything that implied the purchase took effect now would be the "I spent my credit and got
 *       nothing" complaint arriving by a different route.</li>
 * </ul>
 *
 * <p>A refusal is shown in the server's own words. Those sentences name the plan already held and
 * state that nothing was charged, which is the fact somebody needs first and which no table on this
 * side could supply.</p>
 *
 * <p><b>Nothing here buys credit.</b> This spends it, on a non-refundable time-boxed grant, and
 * there is no other direction: monetization.md section 8.1 rules out purchase, gifting, transfer,
 * refund and withdrawal, and the server has no route for any of them.</p>
 */
@Component({
    selector: 'app-credit-purchase-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    templateUrl: './credit-purchase-dialog.component.html',
})
export class CreditPurchaseDialogComponent {
    visible = model.required<boolean>();
    sku = input.required<CreditSkuDto>();
    subject = input.required<EntitlementSubjectRef>();
    /** The wallet balance the catalogue was read with, for the "left after this" line. */
    balance = input.required<number>();
    /** The section 8.1 sentence, already resolved to a key or to the server's text. */
    disclaimer = input<{key: string | null; text: string | null} | null>(null);

    /** Emitted on a completed spend, so the wallet and the catalogue behind this can be re-read. */
    purchased = output<CreditPurchaseDto>();

    private credit = inject(CreditService);
    private entitlements = inject(EntitlementStore);

    protected step = signal<PurchaseStep>('confirm');
    protected result = signal<CreditPurchaseDto | null>(null);
    /** Our sentence, or null when {@link errorText} carries the server's. */
    protected errorKey = signal<string | null>(null);
    protected errorText = signal<string | null>(null);

    /**
     * The key this dialog's purchase is made under.
     *
     * <p>Not a signal: nothing renders it, and making it one would invite a template read that
     * created the impression it changes. It changes exactly once per open.</p>
     */
    private idempotencyKey = newIdempotencyKey();

    protected cash = computed(() => {
        const sku = this.sku();
        return sku.cashPriceMinorUnits === null || sku.cashCurrency === null
            ? null
            : formatMinor(sku.cashPriceMinorUnits, sku.cashCurrency);
    });

    /** What is left afterwards. Shown before the press, because it is the question people ask. */
    protected balanceAfter = computed(() => this.balance() - this.sku().pricePoints);

    protected affordable = computed(() => this.balanceAfter() >= 0);

    protected busy = computed(() => this.step() === 'buying');

    protected outcome = computed(() => {
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

    /**
     * Spends the credit, or retries the same spend.
     *
     * <p>The retry sends the key the first attempt used. That is what makes it a retry: the server
     * hands back the grant the original request produced rather than issuing a second one and
     * charging for it.</p>
     */
    protected confirm(): void {
        if (this.busy() || !this.affordable()) return;

        this.step.set('buying');
        this.errorKey.set(null);
        this.errorText.set(null);

        this.credit.purchase({
            sku: this.sku().code,
            targetId: this.targetId(),
            idempotencyKey: this.idempotencyKey,
        }).subscribe({
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
