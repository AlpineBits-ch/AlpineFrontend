import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {InvoiceDto} from '../../../dtos/response/billing.dto';
import {BillingService} from '../../../services/billing.service';
import {ExternalLinkService} from '../../../services/external-link.service';
import {formatBillingDate, invoiceStatusKey} from '../../../core/subscription-copy';
import {formatMinor} from '../../../core/money';

/** One receipt as the list renders it. */
interface InvoiceRow {
    invoice: InvoiceDto;
    /** The invoice's own number where it has one. A draft has none, and a blank cell is not a row. */
    number: string | null;
    date: string | null;
    statusKey: string;
    amount: string;
    /** Absent on a draft, and a link that leads nowhere is worse than no link. */
    hostedUrl: string | null;
    pdfUrl: string | null;
}

/** The receipts, and two links out to where they actually live. */
@Component({
    selector: 'app-invoice-list',
    imports: [TranslateModule],
    templateUrl: './invoice-list.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvoiceListComponent {
    private billing = inject(BillingService);
    private links = inject(ExternalLinkService);

    protected readonly invoices = signal<InvoiceDto[]>([]);
    protected readonly loading = signal(true);
    protected readonly loadFailed = signal(false);

    /** Three placeholder rows, held rather than written inline so the loop is not rebuilt per cycle. */
    protected readonly skeletonRows = [1, 2, 3];

    protected readonly rows = computed<InvoiceRow[]>(() => this.invoices().map(toRow));

    constructor() {
        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.loadFailed.set(false);
        this.billing.listInvoices().subscribe({
            next: invoices => {
                this.invoices.set(invoices ?? []);
                this.loading.set(false);
            },
            error: () => {
                // A failed read is not an account with no receipts, and "you have no invoices" to
                // somebody looking for one they have already been charged for is a support ticket.
                this.loadFailed.set(true);
                this.loading.set(false);
            },
        });
    }

    protected open(url: string): void {
        void this.links.openExternalLink(url);
    }
}

function toRow(invoice: InvoiceDto): InvoiceRow {
    return {
        invoice,
        number: nonEmpty(invoice.number),
        date: formatBillingDate(invoice.createdAt, 'short'),
        statusKey: invoiceStatusKey(invoice.status),
        amount: formatMinor(invoice.amountDueMinorUnits, invoice.currency),
        hostedUrl: nonEmpty(invoice.hostedInvoiceUrl),
        pdfUrl: nonEmpty(invoice.invoicePdfUrl),
    };
}

function nonEmpty(value: string | null | undefined): string | null {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}
