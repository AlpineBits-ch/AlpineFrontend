import {Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {BillingCatalogueDto, BillingPlanDto, sameSubjectKind} from '../../../dtos/response/billing.dto';
import {BillingService} from '../../../services/billing.service';
import {StripeLoaderService, StripeUnavailableReason} from '../../../services/stripe-loader.service';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {billingErrorCopy} from '../../../core/billing-copy';
import {EntitlementValueCopy, entitlementValueCopy} from '../../../core/entitlement-value';
import {entitlementKeyNameKey} from '../../../core/entitlement-message';
import {formatMinor} from '../../../core/money';
import {CheckoutDialogComponent} from '../checkout-dialog/checkout-dialog.component';

/** One plan as the comparison renders it: the copy, the price, and whether it can be bought. */
interface PlanColumn {
    plan: BillingPlanDto;
    /** Null for a plan with no price, which is how `free` and `free_user` arrive. */
    price: string | null;
    intervalKey: string;
    current: boolean;
    buyable: boolean;
}

interface ComparisonRow {
    /** The catalogue key. Rendered only when this build has no name for it. */
    key: string;
    labelKey: string | null;
    cells: EntitlementValueCopy[];
}

/**
 * What is for sale here, next to what the subject is already on.
 *
 * <p><b>Two gates before a buy button exists at all</b>, and both have to be true: `enabled` from
 * the catalogue, which is answered by the service that actually holds the Stripe secret key, and a
 * non-empty publishable key on the entitlement snapshot. Either one missing means no button - not a
 * disabled one, not one with a tooltip explaining itself. A hosted instance halfway through setting
 * Stripe up is a supported state, and the honest rendering of it is a comparison table with nothing
 * to press.</p>
 *
 * <p>A self-hosted instance never reaches this component: Billing refuses to start there and the
 * settings nav already hides the whole page on `upgradesAvailable`. There is deliberately no second
 * mechanism here for the same thing.</p>
 */
@Component({
    selector: 'app-plan-picker',
    imports: [TranslateModule, CheckoutDialogComponent],
    templateUrl: './plan-picker.component.html',
})
export class PlanPickerComponent {
    subject = input.required<EntitlementSubjectRef>();

    private billing = inject(BillingService);
    private stripe = inject(StripeLoaderService);
    private entitlements = inject(EntitlementStore);

    protected catalogue = signal<BillingCatalogueDto | null>(null);
    protected loading = signal(true);
    /** Our sentence for a catalogue that would not load. Null while nothing has gone wrong. */
    protected loadErrorKey = signal<string | null>(null);
    /** The server's own sentence, when it sent one worth showing. Rendered verbatim. */
    protected loadErrorText = signal<string | null>(null);
    /** Set once Stripe.js has been asked for. `load_failed` is the only one worth a retry. */
    protected stripeReason = signal<StripeUnavailableReason | null>(null);

    protected chosen = signal<BillingPlanDto | null>(null);
    protected checkoutVisible = signal(false);

    /** Half of the two gates, and the cheap half: whether this instance has a publishable key. */
    private keyConfigured = this.stripe.configured;

    /**
     * Whether anything on this screen may be bought.
     *
     * <p>False while the catalogue is still in flight, which is the safe default: a button drawn on
     * an assumption and withdrawn a moment later is worse than one that appears late.</p>
     */
    protected sellable = computed(() => this.catalogue()?.enabled === true && this.keyConfigured());

    /** The plans for this side of the product, in catalogue order - the server orders by price. */
    protected columns = computed<PlanColumn[]>(() => {
        const subject = this.subject();
        const current = this.entitlements.plan(subject)?.name ?? null;
        const sellable = this.sellable();

        return (this.catalogue()?.plans ?? [])
            .filter(plan => sameSubjectKind(plan.subjectKind, subject.kind))
            .map(plan => ({
                plan,
                price: plan.priceMinorUnits === null
                    ? null
                    : formatMinor(plan.priceMinorUnits, plan.currency),
                intervalKey: plan.interval === 'year' ? 'BILLING.INTERVAL.YEAR' : 'BILLING.INTERVAL.MONTH',
                current: current !== null && plan.name === current,
                buyable: sellable && plan.purchasable && plan.name !== current,
            }));
    });

    /**
     * One row per key any of the plans mentions, in the order they first appear.
     *
     * <p>The union rather than the intersection: a key that only the top plan carries is exactly the
     * difference somebody comparing plans is looking for, and dropping it would leave the table
     * showing only what every tier already has.</p>
     */
    protected rows = computed<ComparisonRow[]>(() => {
        const columns = this.columns();
        const keys: string[] = [];
        for (const column of columns) {
            for (const key of Object.keys(column.plan.entitlements ?? {})) {
                if (!keys.includes(key)) keys.push(key);
            }
        }

        return keys.map(key => ({
            key,
            labelKey: entitlementKeyNameKey(key),
            cells: columns.map(column => entitlementValueCopy(key, column.plan.entitlements?.[key])),
        }));
    });

    constructor() {
        effect(() => {
            const subject = this.subject();
            untracked(() => {
                this.entitlements.ensureLoaded(subject);
                this.load();
            });
        });

        // Stripe.js is fetched here and nowhere earlier: it is a third-party script on every launch
        // otherwise, for the overwhelming majority of users who will never buy anything. Warming it
        // when the catalogue says something is for sale means the card field is ready by the time
        // somebody presses a buy button rather than after it.
        effect(() => {
            if (!this.sellable()) return;
            untracked(() => void this.warmStripe());
        });
    }

    protected buy(plan: BillingPlanDto): void {
        this.chosen.set(plan);
        this.checkoutVisible.set(true);
    }

    protected retryStripe(): void {
        this.stripeReason.set(null);
        void this.warmStripe();
    }

    protected reload(): void {
        this.load();
    }

    private load(): void {
        this.loading.set(true);
        this.loadErrorKey.set(null);
        this.loadErrorText.set(null);
        this.billing.getCatalogue().subscribe({
            next: catalogue => {
                this.catalogue.set(catalogue);
                this.loading.set(false);
            },
            error: err => {
                // The plans are gone, not merely unpriced, so this says so rather than rendering an
                // empty table that reads as "this instance sells nothing".
                const copy = billingErrorCopy(err);
                this.loadErrorKey.set(copy.key);
                this.loadErrorText.set(copy.text);
                this.loading.set(false);
            },
        });
    }

    private async warmStripe(): Promise<void> {
        const result = await this.stripe.load();
        this.stripeReason.set(result.reason);
    }
}
