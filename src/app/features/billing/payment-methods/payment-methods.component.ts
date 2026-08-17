import {Component, computed, effect, inject, signal, untracked, viewChild} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {PaymentMethodDto} from '../../../dtos/response/billing.dto';
import {BillingService} from '../../../services/billing.service';
import {billingErrorCopy} from '../../../core/billing-copy';
import {PaymentElementComponent} from '../payment-element/payment-element.component';

/** Card brands as their owners spell them. */
const BRAND_NAMES: Record<string, string> = {
    amex: 'American Express',
    diners: 'Diners Club',
    discover: 'Discover',
    eftpos_au: 'Eftpos Australia',
    jcb: 'JCB',
    mastercard: 'Mastercard',
    unionpay: 'UnionPay',
    visa: 'Visa',
};

/** One card as the list renders it. Brand, last four and expiry are all we hold, by design. */
interface CardRow {
    method: PaymentMethodDto;
    /** The brand's own spelling, or null when this build does not know it. */
    brandName: string | null;
    expiry: string;
}

type AddStep = 'starting' | 'collecting' | 'confirming' | 'refused';

/** Which call is in flight against which row, so the control that was pressed is the one that shows it. */
interface Busy {
    id: string;
    action: 'default' | 'detach';
}

/** What removing the card in the confirmation actually costs. */
type RemovalConsequence = 'only' | 'default' | 'plain';

/** The cards on this account: what is on file, which one pays, and how to add another. */
@Component({
    selector: 'app-payment-methods',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, PaymentElementComponent],
    templateUrl: './payment-methods.component.html',
})
export class PaymentMethodsComponent {
    private billing = inject(BillingService);

    private readonly paymentElement = viewChild(PaymentElementComponent);

    /** Two placeholder rows, held rather than written inline so the loop is not rebuilt per cycle. */
    protected readonly skeletonRows = [1, 2];

    protected readonly cards = signal<CardRow[]>([]);
    protected readonly loading = signal(true);
    protected readonly loadFailed = signal(false);
    /** The row currently being changed, so the spinner sits on the control that was pressed. */
    protected readonly busy = signal<Busy | null>(null);

    /** Our sentence for the last refusal on this screen, or null. */
    protected readonly errorKey = signal<string | null>(null);
    /** A sentence from the server, already customer-worded. */
    protected readonly errorText = signal<string | null>(null);

    /** The card the confirmation is about, and null when nothing is being confirmed. */
    protected readonly pendingRemoval = signal<CardRow | null>(null);

    protected readonly removalConsequence = computed<RemovalConsequence>(() => {
        const pending = this.pendingRemoval();
        if (!pending) return 'plain';
        if (this.cards().length <= 1) return 'only';
        return pending.method.isDefault ? 'default' : 'plain';
    });

    /** True only for the detach behind the open confirmation, so the other rows do not spin. */
    protected readonly removing = computed(() => {
        const pending = this.pendingRemoval();
        const busy = this.busy();
        return pending !== null && busy?.action === 'detach' && busy.id === pending.method.id;
    });

    protected readonly addVisible = signal(false);
    protected readonly addStep = signal<AddStep>('starting');
    protected readonly setupSecret = signal<string | null>(null);
    protected readonly elementReady = signal(false);
    protected readonly addErrorKey = signal<string | null>(null);
    protected readonly addErrorText = signal<string | null>(null);

    constructor() {
        effect(() => {
            if (!this.addVisible()) {
                untracked(() => this.resetAdd());
                return;
            }
            untracked(() => {
                if (this.setupSecret() === null && this.addStep() === 'starting') void this.startAdd();
            });
        });

        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.loadFailed.set(false);
        this.billing.listPaymentMethods().subscribe({
            next: methods => {
                this.cards.set(methods.map(toRow));
                this.loading.set(false);
            },
            error: () => {
                // No list is not an empty list. "You have no cards" would be a lie that invites
                // somebody to add a second copy of the card they already have on file.
                this.loadFailed.set(true);
                this.loading.set(false);
            },
        });
    }

    protected makeDefault(method: PaymentMethodDto): void {
        if (method.isDefault || this.busy() !== null) return;
        this.clearError();
        this.busy.set({id: method.id, action: 'default'});
        this.billing.setDefaultPaymentMethod(method.id).subscribe({
            next: () => {
                this.busy.set(null);
                this.load();
            },
            error: err => {
                this.busy.set(null);
                this.showError(err);
            },
        });
    }

    /** Asks before anything is detached. Nothing is called until the confirmation is pressed. */
    protected confirmRemoval(card: CardRow): void {
        if (this.busy() !== null) return;
        this.clearError();
        this.pendingRemoval.set(card);
    }

    protected cancelRemoval(): void {
        if (this.removing()) return;
        this.pendingRemoval.set(null);
    }

    /** The dialog closing by its own header button, by Escape, or because the detach finished. */
    protected onRemovalVisibleChange(visible: boolean): void {
        if (!visible) this.cancelRemoval();
    }

    protected detach(): void {
        const pending = this.pendingRemoval();
        if (!pending || this.busy() !== null) return;

        this.clearError();
        this.busy.set({id: pending.method.id, action: 'detach'});
        this.billing.deletePaymentMethod(pending.method.id).subscribe({
            next: () => {
                this.busy.set(null);
                this.pendingRemoval.set(null);
                this.load();
            },
            // `last_payment_method` lands here as its own sentence, which is the one refusal on
            // this screen a person can actually act on - and it belongs on the list behind the
            // dialog, where the card they were told to add another of is.
            error: err => {
                this.busy.set(null);
                this.pendingRemoval.set(null);
                this.showError(err);
            },
        });
    }

    protected async confirmAdd(): Promise<void> {
        const element = this.paymentElement();
        if (!element || this.addStep() !== 'collecting') return;

        this.addStep.set('confirming');
        this.addErrorKey.set(null);
        this.addErrorText.set(null);

        const refusal = await element.confirm('setup');
        if (refusal) {
            this.addStep.set('collecting');
            this.addErrorKey.set(refusal.key);
            this.addErrorText.set(refusal.message);
            return;
        }

        this.addVisible.set(false);
        // The card is attached by Stripe, not by us, so the list is re-read rather than appended to
        // from what the browser thinks it just created.
        this.load();
    }

    /** Not while Stripe is deciding: the same rule the checkout keeps about an answer in flight. */
    protected closeAdd(): void {
        if (this.addStep() === 'confirming') return;
        this.addVisible.set(false);
    }

    protected onAddVisibleChange(visible: boolean): void {
        if (visible) {
            this.addVisible.set(true);
            return;
        }
        this.closeAdd();
    }

    private async startAdd(): Promise<void> {
        this.addStep.set('starting');
        try {
            const intent = await firstValueFrom(this.billing.createSetupIntent());
            this.setupSecret.set(intent.clientSecret);
            this.addStep.set('collecting');
        } catch (err) {
            const copy = billingErrorCopy(err);
            this.addErrorKey.set(copy.key);
            this.addErrorText.set(copy.text);
            this.addStep.set('refused');
        }
    }

    private resetAdd(): void {
        this.setupSecret.set(null);
        this.elementReady.set(false);
        this.addErrorKey.set(null);
        this.addErrorText.set(null);
        this.addStep.set('starting');
    }

    private clearError(): void {
        this.errorKey.set(null);
        this.errorText.set(null);
    }

    private showError(err: unknown): void {
        const copy = billingErrorCopy(err);
        this.errorKey.set(copy.key);
        this.errorText.set(copy.text);
    }
}

function toRow(method: PaymentMethodDto): CardRow {
    return {
        method,
        brandName: BRAND_NAMES[method.brand?.toLowerCase() ?? ''] ?? null,
        expiry: `${String(method.expMonth).padStart(2, '0')}/${method.expYear}`,
    };
}
