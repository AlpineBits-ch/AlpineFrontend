import {Component, computed, inject, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CreditEntryDto, CreditLedgerDto} from '../../../dtos/response/credit.dto';
import {CreditService, creditIsAbsent} from '../../../services/credit.service';
import {creditErrorCopy} from '../../../core/credit-copy';
import {formatBillingDate} from '../../../core/subscription-copy';

/** One ledger line as the list renders it. The sentence is the server's; the date and sign are ours. */
interface LedgerRow {
    entry: CreditEntryDto;
    date: string | null;
    /** Credit arriving. Drives the colour only; the sentence already says which way it went. */
    incoming: boolean;
}

/** How many lines are worth showing without a pager. A wallet does not have many. */
const LEDGER_LIMIT = 25;

/**
 * The credit history, in the server's own plain language.
 *
 * <p><b>`summary` is rendered, not composed.</b> Section 8.8 asks for the ledger in plain language
 * and the server writes the sentence - "500 credits added, expiring 12 March" - precisely so that
 * three clients cannot each build their own out of `kind` and `amount` and drift the first time one
 * of them meets a kind it was not built with. The kind is on the payload for a client that wants to
 * translate; nothing here parses the sentence.</p>
 *
 * <p><b>Provenance is not on this screen.</b> `createdBy` is a staff id and `reason` is written for
 * an audit trail rather than for the person who owns the wallet. Both are in the payload because the
 * admin console reads the same shape, and both are deliberately left out here.</p>
 */
@Component({
    selector: 'app-credit-ledger',
    imports: [TranslateModule],
    templateUrl: './credit-ledger.component.html',
})
export class CreditLedgerComponent {
    private credit = inject(CreditService);

    protected ledger = signal<CreditLedgerDto | null>(null);
    protected loading = signal(true);
    /** A 404 means credit does not exist here at all, and the history is absent rather than empty. */
    protected absent = signal(false);
    protected loadErrorKey = signal<string | null>(null);
    protected loadErrorText = signal<string | null>(null);

    protected readonly skeletonRows = [1, 2, 3];

    protected rows = computed<LedgerRow[]>(() => (this.ledger()?.entries ?? []).map(entry => ({
        entry,
        date: formatBillingDate(entry.createdAt, 'short'),
        incoming: entry.amount > 0,
    })));

    constructor() {
        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.loadErrorKey.set(null);
        this.loadErrorText.set(null);

        this.credit.getLedger(LEDGER_LIMIT).subscribe({
            next: ledger => {
                this.ledger.set(ledger);
                this.absent.set(false);
                this.loading.set(false);
            },
            error: err => {
                if (creditIsAbsent(err)) {
                    this.absent.set(true);
                    this.loading.set(false);
                    return;
                }
                // A read that failed is not a wallet with no history. Somebody looking for the
                // credit they were told they had should not be shown an empty list.
                const copy = creditErrorCopy(err);
                this.loadErrorKey.set(copy.key);
                this.loadErrorText.set(copy.text);
                this.loading.set(false);
            },
        });
    }

    /** The signed amount, with the sign kept: a line reads as an addition or a removal on its own. */
    protected amount(entry: CreditEntryDto): string {
        return entry.amount > 0 ? `+${entry.amount}` : String(entry.amount);
    }
}
