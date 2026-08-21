import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import type {StripeAddressElement, StripeElements, StripePaymentElement} from '@stripe/stripe-js';
import {StripeLoaderService, StripeUnavailableReason} from '../../../services/stripe-loader.service';
import {stripeAppearance} from '../../../core/stripe-appearance';

/** What {@link PaymentElementComponent.confirm} is being asked to confirm. */
export type PaymentElementIntent = 'payment' | 'setup';

/** Why a confirmation did not go through. Exactly one field is set. */
export interface PaymentElementRefusal {
    message: string | null;
    key: string | null;
}

/** Stripe refused and said nothing usable about it, which should not happen and sometimes does. */
export const PAYMENT_DECLINED_KEY = 'BILLING.ERROR.CARD_DECLINED';

/** There is no element to confirm - the script never arrived, or the dialog is already closing. */
export const PAYMENT_ELEMENT_MISSING_KEY = 'BILLING.ERROR.ELEMENT_MISSING';

/** The card field, and the only place in this application a card number is allowed to exist. */
@Component({
    selector: 'app-payment-element',
    imports: [TranslateModule],
    templateUrl: './payment-element.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentElementComponent {
    /** From `POST /subscriptions` or `POST /payment-methods/setup-intent`. Never rendered. */
    readonly clientSecret = input.required<string>();
    /** Billing address, for `automatic_tax`. On for a purchase, off for adding a card. */
    readonly collectAddress = input(false);

    /** Fired once the element is mounted, so a host can enable its own submit button. */
    mounted = output<void>();

    private loader = inject(StripeLoaderService);
    private destroyRef = inject(DestroyRef);

    private readonly cardHost = viewChild<ElementRef<HTMLElement>>('cardHost');
    private readonly addressHost = viewChild<ElementRef<HTMLElement>>('addressHost');

    protected readonly status = signal<'loading' | 'ready' | 'unavailable'>('loading');
    /** Why there is no card field, when there is none. */
    protected readonly reason = signal<StripeUnavailableReason | null>(null);

    /** Bumped by the retry button. The effect below reads it, so a retry re-runs the mount. */
    private readonly attempt = signal(0);

    private elements: StripeElements | null = null;
    private paymentElement: StripePaymentElement | null = null;
    private addressElement: StripeAddressElement | null = null;
    /** Which mount the results arriving are for. */
    private generation = 0;

    constructor() {
        effect(() => {
            const secret = this.clientSecret();
            const card = this.cardHost()?.nativeElement;
            const wantsAddress = this.collectAddress();
            const address = wantsAddress ? this.addressHost()?.nativeElement : null;
            this.attempt();

            if (!card || (wantsAddress && !address)) return;
            untracked(() => void this.mount(secret, card, address ?? null));
        });

        // Stripe elements outlive their host node unless they are told not to. A dialog that is
        // closed and reopened would otherwise stack iframes it can no longer reach.
        this.destroyRef.onDestroy(() => this.teardown());
    }

    /**
     * Hands the collected details to Stripe.
     *
     * @returns null when the card was accepted, and otherwise the refusal to render. Stripe's own
     *          messages are written for cardholders ("Your card was declined") and are safe to show
     *          verbatim; ours would be a worse guess at which of forty decline reasons it was.
     */
    async confirm(intent: PaymentElementIntent): Promise<PaymentElementRefusal | null> {
        const stripe = (await this.loader.load()).stripe;
        const elements = this.elements;
        if (!stripe || !elements) return {message: null, key: PAYMENT_ELEMENT_MISSING_KEY};

        // Surfaces the field-level complaints - an incomplete expiry, a missing postcode - inside
        // the element, where they belong, instead of as a sentence at the bottom of the dialog.
        const validation = await elements.submit();
        if (validation.error) return refusal(validation.error.message);

        const result =
            intent === 'setup'
                ? await stripe.confirmSetup({elements, redirect: 'if_required'})
                : await stripe.confirmPayment({elements, redirect: 'if_required'});

        return result.error ? refusal(result.error.message) : null;
    }

    /** A load failure is not memoised by the loader, so this is a real retry rather than a redraw. */
    protected retry(): void {
        this.status.set('loading');
        this.reason.set(null);
        this.attempt.update(n => n + 1);
    }

    private async mount(secret: string, card: HTMLElement, address: HTMLElement | null): Promise<void> {
        this.teardown();
        const generation = ++this.generation;

        this.status.set('loading');
        const result = await this.loader.load();
        if (generation !== this.generation) return;

        if (!result.stripe) {
            this.reason.set(result.reason);
            this.status.set('unavailable');
            return;
        }

        const elements = result.stripe.elements({
            clientSecret: secret,
            appearance: stripeAppearance(),
        });
        const payment = elements.create('payment', {layout: 'tabs'});
        payment.mount(card);

        this.elements = elements;
        this.paymentElement = payment;

        if (address) {
            const addressElement = elements.create('address', {mode: 'billing'});
            addressElement.mount(address);
            this.addressElement = addressElement;
        }

        this.reason.set(null);
        this.status.set('ready');
        this.mounted.emit();
    }

    private teardown(): void {
        this.paymentElement?.destroy();
        this.addressElement?.destroy();
        this.paymentElement = null;
        this.addressElement = null;
        this.elements = null;
    }
}

function refusal(message: string | undefined): PaymentElementRefusal {
    return message ? {message, key: null} : {message: null, key: PAYMENT_DECLINED_KEY};
}
