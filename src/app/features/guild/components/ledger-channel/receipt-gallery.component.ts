import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {
    ExpenseReceipt,
    isAcceptedReceiptType,
    MAX_RECEIPTS_PER_EXPENSE,
    RECEIPT_ACCEPT,
} from '../../../../dtos/response/ledger-insight.dto';
import {LedgerService} from '../../../../services/ledger.service';
import {ToastService} from '../../../../services/toast.service';

/**
 * The receipts on one expense.
 *
 * <p><b>Nothing here is cached, and that is the whole design.</b> A receipt's `url` is presigned and
 * minted per request; storing one stores its expiry, and the symptom is a photo that renders for a
 * few minutes after upload and then 403s forever - indistinguishable, to the person looking at it,
 * from a lost file. So the list is re-read every time this opens, and again after every write, and
 * no URL outlives the panel.</p>
 *
 * <p>Images are shown; a PDF is a link, because there is nothing to preview and an `img` pointed at
 * one renders a broken-image glyph over a receipt that is perfectly fine.</p>
 */
@Component({
    selector: 'app-receipt-gallery',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, TranslateModule],
    templateUrl: './receipt-gallery.component.html',
})
export class ReceiptGalleryComponent {
    expenseId = input.required<string>();
    /** Upload and delete. `AddExpenses` on your own expense, `ManageLedger` on anyone else's. */
    canEdit = input.required<boolean>();

    private ledger = inject(LedgerService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly accept = RECEIPT_ACCEPT;
    protected readonly maxReceipts = MAX_RECEIPTS_PER_EXPENSE;

    protected receipts = signal<ExpenseReceipt[]>([]);
    protected loading = signal(false);
    protected failed = signal(false);
    protected uploading = signal(false);

    protected atCapacity = computed(() => this.receipts().length >= this.maxReceipts);

    constructor() {
        effect(() => {
            const expenseId = this.expenseId();
            untracked(() => this.reload(expenseId));
        });
    }

    protected reload(expenseId = this.expenseId()): void {
        this.loading.set(true);
        this.failed.set(false);
        this.ledger.listReceipts(expenseId).subscribe({
            next: receipts => {
                this.receipts.set(receipts);
                this.loading.set(false);
            },
            error: () => {
                this.loading.set(false);
                this.failed.set(true);
            },
        });
    }

    protected isImage(receipt: ExpenseReceipt): boolean {
        return receipt.contentType.startsWith('image/');
    }

    protected sizeLabel(receipt: ExpenseReceipt): string {
        const kb = receipt.sizeBytes / 1024;
        return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
    }

    protected onFilePicked(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        // Cleared straight away so picking the same file twice still fires a change event - a
        // failed upload retried with the identical photo is the common case.
        input.value = '';
        if (!file) return;

        // Checked before the round trip: a rejection after four megabytes on a phone is a worse
        // answer than a refusal that costs nothing.
        if (!isAcceptedReceiptType(file.type)) {
            this.toast.error(this.translate.instant('RECEIPTS.TYPE_REJECTED'));
            return;
        }
        if (this.atCapacity()) {
            this.toast.error(this.translate.instant('RECEIPTS.AT_CAPACITY', {max: this.maxReceipts}));
            return;
        }

        this.uploading.set(true);
        this.ledger.uploadReceipt(this.expenseId(), file).subscribe({
            next: () => {
                this.uploading.set(false);
                // Re-listed rather than appending the response: the answer carries a URL minted a
                // moment ago, and every other tile's URL is now that much closer to expiring.
                this.reload();
            },
            error: err => {
                this.uploading.set(false);
                this.toast.httpError(this.translate.instant('RECEIPTS.UPLOAD_FAILED'), err);
            },
        });
    }

    protected remove(receipt: ExpenseReceipt): void {
        this.ledger.removeReceipt(this.expenseId(), receipt.id).subscribe({
            next: () => this.receipts.update(all => all.filter(r => r.id !== receipt.id)),
            error: err => this.toast.httpError(this.translate.instant('RECEIPTS.DELETE_FAILED'), err),
        });
    }
}
