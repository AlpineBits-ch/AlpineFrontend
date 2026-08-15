import {Component, computed, inject, input, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {CreditWalletDto} from '../../../dtos/response/credit.dto';
import {CreditService, creditIsAbsent} from '../../../services/credit.service';
import {EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {creditDisclaimerCopy, creditErrorCopy, creditLotCopy} from '../../../core/credit-copy';
import {CreditCatalogueComponent} from '../credit-catalogue/credit-catalogue.component';
import {CreditLedgerComponent} from '../credit-ledger/credit-ledger.component';

/**
 * The promotional balance, where somebody will actually see it (monetization.md section 8.8).
 *
 * <p>Section 8.8 puts this on the plan screen rather than behind a page of its own for a stated
 * reason: an invisible balance generates support tickets at a rate that exceeds what the feature
 * earns. The lots and their dates are here for the same reason - a balance with no expiry beside it
 * is a number that will lapse without warning.</p>
 *
 * <p><b>A 404 removes the section, it does not empty it.</b> That is how a self-hosted instance says
 * credit does not exist here: everything already resolves to its maximum there, so a wallet is
 * meaningless and both an infinite and a zero balance read as a bug. "You have 0 credits" and
 * "credit is not a thing on this instance" are different statements, and the first one gets reported
 * as a defect. Every other failure keeps the section and says the read did not work, because a
 * balance that exists and would not load is not the same as one that does not exist.</p>
 *
 * <p><b>One wallet, two places to spend it.</b> Wallets are user-scoped and guilds never hold one
 * (section 8.4), so the balance shown on a guild's plan page is still the reader's own. What changes
 * with the subject is the catalogue underneath and where a purchase is pointed. The history is the
 * reader's personal ledger and stays on their own account screen.</p>
 *
 * <p><b>There is no control here that buys, gifts, transfers, refunds or withdraws credit.</b>
 * Section 8.1 rules all five out as a hard rule and the server has no route for any of them.</p>
 */
@Component({
    selector: 'app-credit-panel',
    imports: [TranslateModule, CreditCatalogueComponent, CreditLedgerComponent],
    templateUrl: './credit-panel.component.html',
})
export class CreditPanelComponent {
    subject = input.required<EntitlementSubjectRef>();

    private credit = inject(CreditService);
    private translate = inject(TranslateService);

    protected wallet = signal<CreditWalletDto | null>(null);
    protected loading = signal(true);
    /** The instance has no credit surface. Everything below this is absent, not zero. */
    protected absent = signal(false);
    protected loadErrorKey = signal<string | null>(null);
    protected loadErrorText = signal<string | null>(null);

    protected balance = computed(() => this.wallet()?.balance ?? 0);

    /**
     * The lots, soonest to lapse first, each knowing whether it is inside the warning window.
     *
     * <p>Recomputed against `new Date()` at read time rather than held: this panel outlives a
     * session left open overnight, and a threshold decided once at load would keep calling a lot
     * safe on the morning it expires.</p>
     */
    protected lots = computed(() => creditLotCopy(this.wallet()?.lots, new Date()));

    /** True where the wallet is full, which is why the next campaign will appear to skip them. */
    protected atCap = computed(() => {
        const wallet = this.wallet();
        return wallet !== null && wallet.capPoints > 0 && wallet.balance >= wallet.capPoints;
    });

    /**
     * The section 8.1 sentence, preferring the server's key only where this build has the string.
     *
     * <p>Asked of `TranslateService` rather than of the bundled `en.json`, because the active locale
     * is what gets rendered: a key that exists in English and not in the reader's language would
     * otherwise resolve here and reach them as the raw key where a legal notice belongs.</p>
     */
    protected disclaimer = computed(() => {
        const wallet = this.wallet();
        return creditDisclaimerCopy(
            wallet?.disclaimer, wallet?.disclaimerKey, key => this.resolves(key));
    });

    /** The personal ledger belongs on the reader's own screen, not on a server they administer. */
    protected showHistory = computed(() => this.subject().kind === 'user');

    constructor() {
        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.loadErrorKey.set(null);
        this.loadErrorText.set(null);

        this.credit.getWallet().subscribe({
            next: wallet => {
                this.wallet.set(wallet);
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

    /** A spend moved the balance and consumed a lot, so the whole wallet is read again. */
    protected onPurchased(): void {
        this.load();
    }

    private resolves(key: string): boolean {
        const resolved = this.translate.instant(key);
        return typeof resolved === 'string' && resolved.length > 0 && resolved !== key;
    }
}
