import {Component, computed, effect, inject, input, model, output, signal, untracked, viewChild} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {BillingPlanDto, SubscriptionDto} from '../../../dtos/response/billing.dto';
import {BillingService} from '../../../services/billing.service';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {ProfileService} from '../../../services/profile.service';
import {billingErrorCopy, BILLING_GENERIC_ERROR_KEY} from '../../../core/billing-copy';
import {ACTIVATION_POLL_BACKOFF, awaitActivation} from '../../../core/subscription-activation';
import {formatMinor} from '../../../core/money';
import {PaymentElementComponent} from '../payment-element/payment-element.component';

/**
 * Where the customer is in the purchase.
 *
 * <ul>
 *   <li>`starting` - asking Billing to create the subscription. No card has been shown yet.</li>
 *   <li>`collecting` - the Payment Element is mounted and waiting for details.</li>
 *   <li>`confirming` - Stripe has the details and is deciding.</li>
 *   <li>`activating` - the card worked and we are waiting for the webhook, which is the only thing
 *       that makes a subscription live.</li>
 *   <li>`done` - the webhook landed and the new ceilings have been re-read.</li>
 *   <li>`slow` - the wait ran out with nothing decided. <b>Not a failure state.</b></li>
 *   <li>`refused` - something said no, and {@link CheckoutDialogComponent.errorKey} says what.</li>
 * </ul>
 */
type CheckoutStep = 'starting' | 'collecting' | 'confirming' | 'activating' | 'done' | 'slow' | 'refused';

/**
 * Buying one plan, on our screen, in our words.
 *
 * <p>The flow is create -> mount -> confirm -> <b>poll</b> -> re-read entitlements, and the poll is
 * the part that is easy to leave out and impossible to leave out safely. A successful
 * `confirmPayment` means the card worked; it does not mean the subscription is live, because only
 * the webhook decides that. A screen that unlocked anything on the strength of what the browser saw
 * would be the first thing an attacker reached for.</p>
 *
 * <p>The timeout is the other half of that. When the wait runs out, this says the purchase is taking
 * longer than usual and will appear shortly - because it almost certainly is being activated right
 * now, and telling somebody their payment failed when it did not is the worst outcome available
 * here.</p>
 */
@Component({
    selector: 'app-checkout-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, PaymentElementComponent],
    templateUrl: './checkout-dialog.component.html',
})
export class CheckoutDialogComponent {
    visible = model.required<boolean>();
    plan = input.required<BillingPlanDto>();
    subject = input.required<EntitlementSubjectRef>();

    /** Emitted once the subscription is live, for a host that wants to re-read the catalogue. */
    activated = output<SubscriptionDto>();

    private billing = inject(BillingService);
    private entitlements = inject(EntitlementStore);
    private profile = inject(ProfileService);
    private backoff = inject(ACTIVATION_POLL_BACKOFF);

    private paymentElement = viewChild(PaymentElementComponent);

    protected step = signal<CheckoutStep>('starting');
    /** Our sentence for the refusal, or null when {@link errorText} carries somebody else's. */
    protected errorKey = signal<string | null>(null);
    /** A sentence from Stripe or from Billing, already customer-worded. Rendered verbatim. */
    protected errorText = signal<string | null>(null);
    protected clientSecret = signal<string | null>(null);
    protected elementReady = signal(false);

    /** The subscription being paid for. Not a signal: nothing renders it, and the poll reads it. */
    private subscriptionId: string | null = null;

    /**
     * The price, formatted from the plan's own currency.
     *
     * <p>Never a hardcoded symbol and never a division by 100 - this client is pointed at instances
     * that sell in their own currency, and JPY has no minor unit at all.</p>
     */
    protected price = computed(() => {
        const plan = this.plan();
        return plan.priceMinorUnits === null
            ? null
            : formatMinor(plan.priceMinorUnits, plan.currency);
    });

    protected intervalKey = computed(
        () => this.plan().interval === 'year' ? 'BILLING.INTERVAL.YEAR' : 'BILLING.INTERVAL.MONTH');

    /** True once there is something to confirm and nothing already in flight. */
    protected canPay = computed(() => this.step() === 'collecting' && this.elementReady());

    constructor() {
        // Opening is what starts the purchase. Closing resets, so reopening on another plan is a
        // fresh subscription rather than the last one's client secret.
        effect(() => {
            const open = this.visible();
            const plan = this.plan();
            untracked(() => {
                if (!open) {
                    this.reset();
                    return;
                }
                if (this.step() === 'starting' && this.clientSecret() === null) {
                    void this.start(plan);
                }
            });
        });
    }

    protected async pay(): Promise<void> {
        const element = this.paymentElement();
        if (!element || this.step() !== 'collecting') return;

        this.step.set('confirming');
        this.errorKey.set(null);
        this.errorText.set(null);

        const refusal = await element.confirm('payment');
        if (refusal) {
            // Back to collecting, not to a dead end: a declined card is most often fixed by
            // typing a different one into the field that is already on screen.
            this.step.set('collecting');
            this.errorKey.set(refusal.key);
            this.errorText.set(refusal.message);
            return;
        }

        await this.activate();
    }

    /** Closes without cancelling anything. A subscription mid-activation goes on activating. */
    protected close(): void {
        this.visible.set(false);
    }

    private async start(plan: BillingPlanDto): Promise<void> {
        const subjectId = this.subjectId();
        if (!subjectId) {
            this.refuse(BILLING_GENERIC_ERROR_KEY, null);
            return;
        }

        this.step.set('starting');
        try {
            const response = await firstValueFrom(this.billing.createSubscription({
                planName: plan.name,
                subjectKind: this.subject().kind,
                subjectId,
            }));

            this.subscriptionId = response.subscription.id;

            // Null is a success, not an error: Stripe had nothing to confirm, so there is no card
            // to collect and the only thing left is to wait for the webhook.
            if (response.clientSecret === null) {
                await this.activate();
                return;
            }

            this.clientSecret.set(response.clientSecret);
            this.step.set('collecting');
        } catch (err) {
            const copy = billingErrorCopy(err);
            this.refuse(copy.key, copy.text);
        }
    }

    /**
     * Waits for the webhook, then re-reads the ceilings.
     *
     * <p>The invalidate is what makes the purchase visible: without it the store answers from a
     * snapshot fetched before the plan moved, for as long as its TTL lasts, and the customer sees
     * the limits they just paid to raise.</p>
     */
    private async activate(): Promise<void> {
        const id = this.subscriptionId;
        if (!id) {
            this.refuse(BILLING_GENERIC_ERROR_KEY, null);
            return;
        }

        this.step.set('activating');
        const result = await awaitActivation(
            () => firstValueFrom(this.billing.getSubscription(id)),
            {backoffMs: this.backoff},
        );

        if (result.outcome === 'ended') {
            this.refuse('BILLING.ERROR.NOT_ACTIVATED', null);
            return;
        }

        // Both live and slow drop what is held. On the slow path the activation is most likely
        // moments away, and a stale snapshot would then outlive it by the whole of its TTL.
        const subject = this.subject();
        this.entitlements.invalidate(subject);
        this.entitlements.ensureLoaded(subject);

        if (result.outcome === 'live') {
            this.step.set('done');
            if (result.subscription) this.activated.emit(result.subscription);
            return;
        }
        this.step.set('slow');
    }

    private refuse(key: string | null, text: string | null): void {
        this.errorKey.set(key);
        this.errorText.set(text);
        this.step.set('refused');
    }

    /** The guild, or this account. `me` is a routing shorthand and is not an id the server takes. */
    private subjectId(): string | null {
        const subject = this.subject();
        return subject.kind === 'guild'
            ? subject.id
            : this.profile.ownProfile()?.userId ?? null;
    }

    private reset(): void {
        this.subscriptionId = null;
        this.clientSecret.set(null);
        this.elementReady.set(false);
        this.errorKey.set(null);
        this.errorText.set(null);
        this.step.set('starting');
    }
}
