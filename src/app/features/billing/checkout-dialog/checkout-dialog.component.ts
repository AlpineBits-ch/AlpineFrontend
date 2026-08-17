import {
    Component,
    computed,
    effect,
    inject,
    input,
    model,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {BillingPlanDto, SubscriptionDto} from '../../../dtos/response/billing.dto';
import {BILLING_ERROR_CODES, BillingService, describeBillingError} from '../../../services/billing.service';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {ProfileService} from '../../../services/profile.service';
import {billingErrorCopy, BILLING_GENERIC_ERROR_KEY} from '../../../core/billing-copy';
import {ACTIVATION_POLL_BACKOFF, awaitActivation} from '../../../core/subscription-activation';
import {formatMinor} from '../../../core/money';
import {PaymentElementComponent} from '../payment-element/payment-element.component';

/** Where the customer is in the purchase. */
type CheckoutStep = 'starting' | 'collecting' | 'confirming' | 'activating' | 'done' | 'slow' | 'refused';

/** Buying one plan, on our screen, in our words. */
@Component({
    selector: 'app-checkout-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, PaymentElementComponent],
    templateUrl: './checkout-dialog.component.html',
})
export class CheckoutDialogComponent {
    readonly visible = model.required<boolean>();
    readonly plan = input.required<BillingPlanDto>();
    readonly subject = input.required<EntitlementSubjectRef>();

    /** Emitted once the subscription is live, for a host that wants to re-read the catalogue. */
    activated = output<SubscriptionDto>();

    /** Asked for when the purchase was refused because this subject is already subscribed. */
    changeRequested = output<void>();

    private billing = inject(BillingService);
    private entitlements = inject(EntitlementStore);
    private profile = inject(ProfileService);
    private backoff = inject(ACTIVATION_POLL_BACKOFF);

    private readonly paymentElement = viewChild(PaymentElementComponent);

    protected readonly step = signal<CheckoutStep>('starting');
    /** Our sentence for the refusal, or null when {@link errorText} carries somebody else's. */
    protected readonly errorKey = signal<string | null>(null);
    /** A sentence from Stripe or from Billing, already customer-worded. Rendered verbatim. */
    protected readonly errorText = signal<string | null>(null);
    protected readonly clientSecret = signal<string | null>(null);
    protected readonly elementReady = signal(false);
    /** Whether the refusal on screen is the one the change dialog is the answer to. */
    protected readonly alreadySubscribed = signal(false);

    /** The subscription being paid for. Not a signal: nothing renders it, and the poll reads it. */
    private subscriptionId: string | null = null;

    /** The price, formatted from the plan's own currency. */
    protected readonly price = computed(() => {
        const plan = this.plan();
        return plan.priceMinorUnits === null ? null : formatMinor(plan.priceMinorUnits, plan.currency);
    });

    protected readonly intervalKey = computed(() =>
        this.plan().interval === 'year' ? 'BILLING.INTERVAL.YEAR' : 'BILLING.INTERVAL.MONTH',
    );

    /** True once there is something to confirm and nothing already in flight. */
    protected readonly canPay = computed(() => this.step() === 'collecting' && this.elementReady());

    /**
     * Whether money is currently moving, which is the whole of the reason this dialog can refuse to
     * close: both of these steps end in a state that says what happened, and neither can be left.
     */
    protected readonly busy = computed(() => this.step() === 'confirming' || this.step() === 'activating');

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

    /** Closes, unless a card is being confirmed or a subscription activated. */
    protected close(): void {
        if (this.busy()) return;
        this.visible.set(false);
    }

    /** The header button, Escape, and the backdrop all arrive here. None of them outrank the wait. */
    protected onVisibleChange(visible: boolean): void {
        if (visible) {
            this.visible.set(true);
            return;
        }
        this.close();
    }

    /** Hands the refusal over to the flow that can act on it, and gets out of its way. */
    protected requestChange(): void {
        this.changeRequested.emit();
        this.close();
    }

    private async start(plan: BillingPlanDto): Promise<void> {
        const subjectId = this.subjectId();
        if (!subjectId) {
            this.refuse(BILLING_GENERIC_ERROR_KEY, null);
            return;
        }

        this.step.set('starting');
        try {
            const response = await firstValueFrom(
                this.billing.createSubscription({
                    planName: plan.name,
                    subjectKind: this.subject().kind,
                    subjectId,
                }),
            );

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
            this.alreadySubscribed.set(
                describeBillingError(err)?.code === BILLING_ERROR_CODES.alreadySubscribed,
            );
            const copy = billingErrorCopy(err);
            this.refuse(copy.key, copy.text);
        }
    }

    /** Waits for the webhook, then re-reads the ceilings. */
    private async activate(): Promise<void> {
        const id = this.subscriptionId;
        if (!id) {
            this.refuse(BILLING_GENERIC_ERROR_KEY, null);
            return;
        }

        this.step.set('activating');
        const result = await awaitActivation(() => firstValueFrom(this.billing.getSubscription(id)), {
            backoffMs: this.backoff,
        });

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
        return subject.kind === 'guild' ? subject.id : (this.profile.ownProfile()?.userId ?? null);
    }

    private reset(): void {
        this.subscriptionId = null;
        this.clientSecret.set(null);
        this.elementReady.set(false);
        this.errorKey.set(null);
        this.errorText.set(null);
        this.alreadySubscribed.set(false);
        this.step.set('starting');
    }
}
