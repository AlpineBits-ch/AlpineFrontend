import {Component, effect, inject, signal, untracked, viewChild} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {PaymentMethodDto} from '../../../dtos/response/billing.dto';
import {BillingService} from '../../../services/billing.service';
import {billingErrorCopy} from '../../../core/billing-copy';
import {PaymentElementComponent} from '../payment-element/payment-element.component';

/**
 * Card brands as their owners spell them.
 *
 * <p>Not translation keys: "Mastercard" is a proper noun and is the same word in every locale this
 * app ships. A brand nobody here has heard of falls back to a key that says so rather than
 * rendering `"cartes_bancaires"` at somebody.</p>
 */
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

/**
 * The cards on this account: what is on file, which one pays, and how to add another.
 *
 * <p>Brand, last four and expiry are the entirety of the card data that exists on our side, and
 * that is the whole point of Elements - adding one here goes through a SetupIntent and the same
 * iframe a purchase uses, so no card number ever reaches this origin.</p>
 *
 * <p>Detaching the last card under a live subscription is refused by the server, and that refusal is
 * rendered as a sentence explaining what to do instead. Stripe would otherwise accept the detach and
 * fail the next invoice, which turns a refusable action into a support ticket a month later - so the
 * one thing this screen must not do is show it as "409".</p>
 */
@Component({
    selector: 'app-payment-methods',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, PaymentElementComponent],
    templateUrl: './payment-methods.component.html',
})
export class PaymentMethodsComponent {
    private billing = inject(BillingService);

    private paymentElement = viewChild(PaymentElementComponent);

    protected cards = signal<CardRow[]>([]);
    protected loading = signal(true);
    protected loadFailed = signal(false);
    /** The id currently being changed, so one row can be busy without freezing the list. */
    protected busyId = signal<string | null>(null);

    /** Our sentence for the last refusal on this screen, or null. */
    protected errorKey = signal<string | null>(null);
    /** A sentence from the server, already customer-worded. */
    protected errorText = signal<string | null>(null);

    protected addVisible = signal(false);
    protected addStep = signal<AddStep>('starting');
    protected setupSecret = signal<string | null>(null);
    protected elementReady = signal(false);
    protected addErrorKey = signal<string | null>(null);
    protected addErrorText = signal<string | null>(null);

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
        if (method.isDefault || this.busyId() !== null) return;
        this.clearError();
        this.busyId.set(method.id);
        this.billing.setDefaultPaymentMethod(method.id).subscribe({
            next: () => {
                this.busyId.set(null);
                this.load();
            },
            error: err => {
                this.busyId.set(null);
                this.showError(err);
            },
        });
    }

    protected detach(method: PaymentMethodDto): void {
        if (this.busyId() !== null) return;
        this.clearError();
        this.busyId.set(method.id);
        this.billing.deletePaymentMethod(method.id).subscribe({
            next: () => {
                this.busyId.set(null);
                this.load();
            },
            // `last_payment_method` lands here as its own sentence, which is the one refusal on
            // this screen a person can actually act on.
            error: err => {
                this.busyId.set(null);
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

    protected closeAdd(): void {
        this.addVisible.set(false);
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
