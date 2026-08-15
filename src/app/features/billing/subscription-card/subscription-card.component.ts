import {Component, computed, effect, ElementRef, inject, input, signal, untracked} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {
    SubscriptionDto,
    sameSubjectKind,
    subscriptionStanding,
} from '../../../dtos/response/billing.dto';
import {BillingService, BILLING_ERROR_CODES, describeBillingError} from '../../../services/billing.service';
import {ProfileService} from '../../../services/profile.service';
import {EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {billingErrorCopy} from '../../../core/billing-copy';
import {formatBillingDate, standingLabelKey, subscriptionPriceCopy} from '../../../core/subscription-copy';
import {ChangePlanDialogComponent} from '../change-plan-dialog/change-plan-dialog.component';

/** Which network call is in flight, so the control that was pressed is the one that shows it. */
type Busy = 'cancel' | 'resume' | null;

/**
 * The subscription behind a subject: what it costs, when it renews, and how to stop it.
 *
 * <p>Three things on this card are load-bearing and all three are easy to render wrongly:</p>
 *
 * <ul>
 *   <li><b>The standing, never the raw status.</b> Stripe's vocabulary grows, and
 *       {@link subscriptionStanding} answers "needs attention" for anything this build has not seen
 *       rather than crashing or - far worse - guessing "active".</li>
 *   <li><b>A grace period is a sentence, not a chip.</b> `gracePeriodEndsAt` non-null means a
 *       payment failed and the tier is being held until that moment. The person most likely to be
 *       reading this screen is the one whose card just expired, and a chip tells them nothing they
 *       can act on.</li>
 *   <li><b>`isPayer` false means no actions at all.</b> Not disabled ones: they manage the guild and
 *       somebody else's card is behind it, so a cancel button here would be a 403 with extra steps.
 *       </li>
 * </ul>
 *
 * <p>Cancelling changes nothing today - it sets `cancel_at_period_end` - so nothing here invalidates
 * the entitlement snapshot. The plan does not move until the period does. A <b>change</b> of plan is
 * the opposite case, and the dialog that performs it invalidates for exactly that reason.</p>
 */
@Component({
    selector: 'app-subscription-card',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, ChangePlanDialogComponent],
    templateUrl: './subscription-card.component.html',
})
export class SubscriptionCardComponent {
    subject = input.required<EntitlementSubjectRef>();

    private billing = inject(BillingService);
    private profile = inject(ProfileService);
    private host = inject(ElementRef<HTMLElement>);

    protected subscription = signal<SubscriptionDto | null>(null);
    protected loading = signal(true);
    protected loadFailed = signal(false);
    protected busy = signal<Busy>(null);

    /** Our sentence for the last refusal, or null when {@link errorText} carries somebody else's. */
    protected errorKey = signal<string | null>(null);
    /** A sentence from the server, already customer-worded. Rendered verbatim. */
    protected errorText = signal<string | null>(null);
    /**
     * Set when a resume was refused because the subscription had already ended.
     *
     * <p>The refusal on its own is a dead end - the button they pressed cannot ever work again - so
     * this is what turns it into a sentence pointing at the plans further down the same page.</p>
     */
    protected lapsed = signal(false);

    protected cancelVisible = signal(false);
    protected changeVisible = signal(false);

    protected standingKey = computed(() => {
        const current = this.subscription();
        return current ? standingLabelKey(current.status) : null;
    });

    protected standing = computed(() => {
        const current = this.subscription();
        return current ? subscriptionStanding(current.status) : null;
    });

    /**
     * The chip's colour, which is never the only thing carrying the meaning.
     *
     * <p>Every one of the four standings has its own word beside it, so a reader who cannot tell
     * amber from red loses nothing. The colour is emphasis on a sentence that already exists.</p>
     */
    protected standingClass = computed(() => {
        switch (this.standing()) {
            case 'live':
                return 'text-[var(--color-online)] bg-[color-mix(in_srgb,var(--color-online)_14%,transparent)]';
            case 'pending':
                return 'text-[var(--color-connecting)] bg-[color-mix(in_srgb,var(--color-connecting)_14%,transparent)]';
            case 'attention':
                return 'text-[var(--color-offline)] bg-[color-mix(in_srgb,var(--color-offline)_14%,transparent)]';
            default:
                return 'text-text-muted bg-white/[0.06]';
        }
    });

    /**
     * The price as a rate - "$29.00 per month" - never a bare amount beside a date.
     *
     * <p>Never a hardcoded symbol and never a division by 100; JPY has no minor unit at all. The
     * cadence half is absent rather than guessed at where the server did not state it, which
     * includes every response from a build that predates the field.</p>
     */
    protected price = computed(() => {
        const current = this.subscription();
        return current
            ? subscriptionPriceCopy(current.priceMinorUnits, current.currency, current.interval)
            : null;
    });

    protected periodEnd = computed(() => formatBillingDate(this.subscription()?.currentPeriodEnd));

    protected graceEnd = computed(() => formatBillingDate(this.subscription()?.gracePeriodEndsAt));

    /**
     * Whether this reader may act on the subscription at all.
     *
     * <p>An ended subscription has nothing left to cancel, resume or move, so the actions are absent
     * rather than present and refused.</p>
     */
    protected canAct = computed(() => {
        const current = this.subscription();
        return current !== null && current.isPayer && this.standing() !== 'ended';
    });

    /** The one action available on a subscription that is already winding down. */
    protected canResume = computed(() => this.canAct() && this.subscription()?.cancelAtPeriodEnd === true);

    protected canCancel = computed(() => this.canAct() && this.subscription()?.cancelAtPeriodEnd !== true);

    constructor() {
        effect(() => {
            const subject = this.subject();
            untracked(() => this.load(subject));
        });
    }

    /**
     * Set when a change was asked for before this card had a subscription to change.
     *
     * <p>The only way in is a checkout refused with `already_subscribed`, which is the server saying
     * a subscription exists that this card has not managed to read - a failed list, or one that
     * landed before the purchase. So the request survives one re-read rather than being dropped.</p>
     */
    private openChangeOnLoad = false;

    /**
     * Opens the change dialog on somebody else's behalf.
     *
     * <p>Called by the plan page when a purchase was refused because this subject is already
     * subscribed. The scroll happens either way: the card can be off-screen behind the plans, and an
     * affordance whose entire effect is somewhere the reader cannot see is the same dead end in a
     * different place.</p>
     */
    requestChangePlan(): void {
        this.host.nativeElement.scrollIntoView?.({block: 'nearest'});

        if (this.canAct()) {
            this.openChange();
            return;
        }
        if (this.subscription() === null) {
            this.openChangeOnLoad = true;
            this.reload();
        }
    }

    protected reload(): void {
        this.load(this.subject());
    }

    protected confirmCancel(): void {
        if (this.busy() !== null) return;
        this.cancelVisible.set(true);
    }

    protected cancel(): void {
        const current = this.subscription();
        if (!current || this.busy() !== null) return;

        this.clearError();
        this.busy.set('cancel');
        this.billing.cancelSubscription(current.id).subscribe({
            next: updated => {
                this.busy.set(null);
                this.cancelVisible.set(false);
                // The server's copy of the subscription, not a locally flipped flag: the period end
                // it comes back with is the date every sentence on this card is now built around.
                this.subscription.set(updated);
            },
            error: err => {
                this.busy.set(null);
                this.cancelVisible.set(false);
                this.showError(err);
            },
        });
    }

    protected resume(): void {
        const current = this.subscription();
        if (!current || this.busy() !== null) return;

        this.clearError();
        this.busy.set('resume');
        this.billing.resumeSubscription(current.id).subscribe({
            next: updated => {
                this.busy.set(null);
                this.subscription.set(updated);
            },
            error: err => {
                this.busy.set(null);
                this.showError(err);
                if (describeBillingError(err)?.code === BILLING_ERROR_CODES.subscriptionLapsed) {
                    // The card is showing a subscription the server says is over. Re-read it so the
                    // resume button stops being offered, and keep the sentence explaining why.
                    this.lapsed.set(true);
                    this.load(this.subject(), {keepError: true});
                }
            },
        });
    }

    protected openChange(): void {
        if (this.busy() !== null) return;
        this.clearError();
        this.changeVisible.set(true);
    }

    /** The changed subscription, straight from the server rather than patched together here. */
    protected onChanged(updated: SubscriptionDto): void {
        this.subscription.set(updated);
    }

    private load(subject: EntitlementSubjectRef, opts: {keepError?: boolean} = {}): void {
        const subjectId = this.subjectId(subject);
        if (!subjectId) {
            // The account has not been read yet. Nothing to look up, and an empty card would claim
            // this subject has no subscription.
            this.loading.set(true);
            return;
        }

        this.loading.set(true);
        this.loadFailed.set(false);
        if (!opts.keepError) this.clearError();

        this.billing.listSubscriptions().subscribe({
            next: all => {
                this.subscription.set(pickFor(all, subject.kind, subjectId));
                this.loading.set(false);

                if (this.openChangeOnLoad) {
                    this.openChangeOnLoad = false;
                    if (this.canAct()) this.openChange();
                }
            },
            error: () => {
                // A failed read is not "no subscription". Telling a paying customer they have none
                // is the one wrong answer available here.
                this.openChangeOnLoad = false;
                this.loadFailed.set(true);
                this.loading.set(false);
            },
        });
    }

    /** The guild, or this account. `me` is a routing shorthand and not an id the server takes. */
    private subjectId(subject: EntitlementSubjectRef): string | null {
        return subject.kind === 'guild' ? subject.id : this.profile.ownProfile()?.userId ?? null;
    }

    private clearError(): void {
        this.errorKey.set(null);
        this.errorText.set(null);
        this.lapsed.set(false);
    }

    private showError(err: unknown): void {
        const copy = billingErrorCopy(err);
        this.errorKey.set(copy.key);
        this.errorText.set(copy.text);
    }
}

/**
 * The subscription for one subject, out of everything the caller can see.
 *
 * <p>The list carries what they pay for <b>and</b> every guild they manage, so it is filtered rather
 * than taken at the head. A live one wins over an ended one: a guild that has been subscribed twice
 * has both in the list, and the cancelled one is not the subscription this card is about.</p>
 */
function pickFor(all: SubscriptionDto[], kind: string, subjectId: string): SubscriptionDto | null {
    const mine = (all ?? []).filter(
        s => sameSubjectKind(s.subjectKind, kind) && s.subjectId === subjectId);
    return mine.find(s => subscriptionStanding(s.status) !== 'ended') ?? mine[0] ?? null;
}
