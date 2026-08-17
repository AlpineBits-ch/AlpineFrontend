import {Component, computed, effect, ElementRef, inject, input, signal, untracked} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {SubscriptionDto, sameSubjectKind, subscriptionStanding} from '../../../dtos/response/billing.dto';
import {BillingService, BILLING_ERROR_CODES, describeBillingError} from '../../../services/billing.service';
import {ProfileService} from '../../../services/profile.service';
import {EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {billingErrorCopy} from '../../../core/billing-copy';
import {formatBillingDate, standingLabelKey, subscriptionPriceCopy} from '../../../core/subscription-copy';
import {ChangePlanDialogComponent} from '../change-plan-dialog/change-plan-dialog.component';

/** Which network call is in flight, so the control that was pressed is the one that shows it. */
type Busy = 'cancel' | 'resume' | null;

/** The subscription behind a subject: what it costs, when it renews, and how to stop it. */
@Component({
    selector: 'app-subscription-card',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule, ChangePlanDialogComponent],
    templateUrl: './subscription-card.component.html',
})
export class SubscriptionCardComponent {
    readonly subject = input.required<EntitlementSubjectRef>();

    private billing = inject(BillingService);
    private profile = inject(ProfileService);
    private host = inject(ElementRef<HTMLElement>);

    protected readonly subscription = signal<SubscriptionDto | null>(null);
    protected readonly loading = signal(true);
    protected readonly loadFailed = signal(false);
    protected readonly busy = signal<Busy>(null);

    /** Our sentence for the last refusal, or null when {@link errorText} carries somebody else's. */
    protected readonly errorKey = signal<string | null>(null);
    /** A sentence from the server, already customer-worded. Rendered verbatim. */
    protected readonly errorText = signal<string | null>(null);
    /** Set when a resume was refused because the subscription had already ended. */
    protected readonly lapsed = signal(false);

    protected readonly cancelVisible = signal(false);
    protected readonly changeVisible = signal(false);

    protected readonly standingKey = computed(() => {
        const current = this.subscription();
        return current ? standingLabelKey(current.status) : null;
    });

    protected readonly standing = computed(() => {
        const current = this.subscription();
        return current ? subscriptionStanding(current.status) : null;
    });

    /** The chip's colour, which is never the only thing carrying the meaning. */
    protected readonly standingClass = computed(() => {
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

    /** The price as a rate - "$29.00 per month" - never a bare amount beside a date. */
    protected readonly price = computed(() => {
        const current = this.subscription();
        return current
            ? subscriptionPriceCopy(current.priceMinorUnits, current.currency, current.interval)
            : null;
    });

    protected readonly periodEnd = computed(() => formatBillingDate(this.subscription()?.currentPeriodEnd));

    protected readonly graceEnd = computed(() => formatBillingDate(this.subscription()?.gracePeriodEndsAt));

    /** Whether this reader may act on the subscription at all. */
    protected readonly canAct = computed(() => {
        const current = this.subscription();
        return current !== null && current.isPayer && this.standing() !== 'ended';
    });

    /** The one action available on a subscription that is already winding down. */
    protected readonly canResume = computed(
        () => this.canAct() && this.subscription()?.cancelAtPeriodEnd === true,
    );

    protected readonly canCancel = computed(
        () => this.canAct() && this.subscription()?.cancelAtPeriodEnd !== true,
    );

    constructor() {
        effect(() => {
            const subject = this.subject();
            untracked(() => this.load(subject));
        });
    }

    /** Set when a change was asked for before this card had a subscription to change. */
    private openChangeOnLoad = false;

    /** Opens the change dialog on somebody else's behalf. */
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
        return subject.kind === 'guild' ? subject.id : (this.profile.ownProfile()?.userId ?? null);
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

/** The subscription for one subject, out of everything the caller can see. */
function pickFor(all: SubscriptionDto[], kind: string, subjectId: string): SubscriptionDto | null {
    const mine = (all ?? []).filter(s => sameSubjectKind(s.subjectKind, kind) && s.subjectId === subjectId);
    return mine.find(s => subscriptionStanding(s.status) !== 'ended') ?? mine[0] ?? null;
}
