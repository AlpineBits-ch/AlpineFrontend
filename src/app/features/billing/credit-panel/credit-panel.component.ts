import {Component, computed, inject, input, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {CreditWalletDto} from '../../../dtos/response/credit.dto';
import {CreditService, creditIsAbsent} from '../../../services/credit.service';
import {EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {creditDisclaimerCopy, creditErrorCopy, creditLotCopy} from '../../../core/credit-copy';
import {CreditCatalogueComponent} from '../credit-catalogue/credit-catalogue.component';
import {CreditLedgerComponent} from '../credit-ledger/credit-ledger.component';

/** The promotional balance, where somebody will actually see it (monetization.md section 8.8). */
@Component({
    selector: 'app-credit-panel',
    imports: [TranslateModule, CreditCatalogueComponent, CreditLedgerComponent],
    templateUrl: './credit-panel.component.html',
})
export class CreditPanelComponent {
    readonly subject = input.required<EntitlementSubjectRef>();

    private credit = inject(CreditService);
    private translate = inject(TranslateService);

    protected readonly wallet = signal<CreditWalletDto | null>(null);
    protected readonly loading = signal(true);
    /** The instance has no credit surface. Everything below this is absent, not zero. */
    protected readonly absent = signal(false);
    protected readonly loadErrorKey = signal<string | null>(null);
    protected readonly loadErrorText = signal<string | null>(null);

    protected readonly balance = computed(() => this.wallet()?.balance ?? 0);

    /** The lots, soonest to lapse first, each knowing whether it is inside the warning window. */
    protected readonly lots = computed(() => creditLotCopy(this.wallet()?.lots, new Date()));

    /** True where the wallet is full, which is why the next campaign will appear to skip them. */
    protected readonly atCap = computed(() => {
        const wallet = this.wallet();
        return wallet !== null && wallet.capPoints > 0 && wallet.balance >= wallet.capPoints;
    });

    /** The section 8.1 sentence, preferring the server's key only where this build has the string. */
    protected readonly disclaimer = computed(() => {
        const wallet = this.wallet();
        return creditDisclaimerCopy(wallet?.disclaimer, wallet?.disclaimerKey, key => this.resolves(key));
    });

    /** The personal ledger belongs on the reader's own screen, not on a server they administer. */
    protected readonly showHistory = computed(() => this.subject().kind === 'user');

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
