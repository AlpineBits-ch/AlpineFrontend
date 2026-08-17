import {Component, computed, effect, inject, input, model, output, signal, untracked} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {
    BillingPlanDto,
    ChangePreviewDto,
    SubscriptionDto,
    sameSubjectKind,
} from '../../../dtos/response/billing.dto';
import {BillingService} from '../../../services/billing.service';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {billingErrorCopy} from '../../../core/billing-copy';
import {
    ImmediateAmountCopy,
    PreviewLineCopy,
    formatBillingDate,
    immediateAmountCopy,
    previewLineCopy,
} from '../../../core/subscription-copy';
import {formatMinor} from '../../../core/money';

/** A refusal as it renders: one of ours, or one of the server's, never both. */
interface Refusal {
    key: string | null;
    text: string | null;
}

/** One plan the subscription could move to. */
interface PlanOption {
    plan: BillingPlanDto;
    price: string | null;
    intervalKey: string;
}

/** Moving a live subscription to another plan, with the proration shown first. */
@Component({
    selector: 'app-change-plan-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    templateUrl: './change-plan-dialog.component.html',
})
export class ChangePlanDialogComponent {
    readonly visible = model.required<boolean>();
    readonly subscription = input.required<SubscriptionDto>();
    readonly subject = input.required<EntitlementSubjectRef>();

    /** The updated subscription, for a host that renders it. Emitted once, on success. */
    changed = output<SubscriptionDto>();

    private billing = inject(BillingService);
    private entitlements = inject(EntitlementStore);

    /** Two placeholder rows, held rather than written inline so the loop is not rebuilt per cycle. */
    protected readonly skeletonRows = [1, 2];

    protected readonly catalogueLoading = signal(true);
    protected readonly catalogueError = signal<Refusal | null>(null);
    protected readonly plans = signal<BillingPlanDto[]>([]);

    protected readonly selected = signal<BillingPlanDto | null>(null);

    protected readonly previewLoading = signal(false);
    protected readonly previewError = signal<Refusal | null>(null);
    protected readonly preview = signal<ChangePreviewDto | null>(null);

    protected readonly applying = signal(false);
    protected readonly applyError = signal<Refusal | null>(null);
    protected readonly applied = signal<SubscriptionDto | null>(null);

    /** Discards a preview that arrives after the selection moved on. */
    private previewToken = 0;

    /** What this subscription could move to: same side of the product, sold, and not the current. */
    protected readonly options = computed<PlanOption[]>(() => {
        const current = this.subscription();
        return this.plans()
            .filter(plan => sameSubjectKind(plan.subjectKind, current.subjectKind))
            .filter(plan => plan.purchasable && plan.name !== current.planName)
            .map(plan => ({
                plan,
                price:
                    plan.priceMinorUnits === null ? null : formatMinor(plan.priceMinorUnits, plan.currency),
                intervalKey: plan.interval === 'year' ? 'BILLING.INTERVAL.YEAR' : 'BILLING.INTERVAL.MONTH',
            }));
    });

    /** The amount that leaves or arrives the moment they confirm, in words as well as in figures. */
    protected readonly immediate = computed<ImmediateAmountCopy | null>(() => {
        const preview = this.preview();
        return preview ? immediateAmountCopy(preview.immediateChargeMinorUnits, preview.currency) : null;
    });

    protected readonly lines = computed<PreviewLineCopy[]>(() => {
        const preview = this.preview();
        return preview ? previewLineCopy(preview) : [];
    });

    protected readonly nextInvoiceTotal = computed(() => {
        const preview = this.preview();
        return preview ? formatMinor(preview.nextInvoiceTotalMinorUnits, preview.currency) : null;
    });

    protected readonly nextInvoiceAt = computed(() => formatBillingDate(this.preview()?.nextInvoiceAt));

    /** Nothing is confirmable until a preview for this exact selection has been read back. */
    protected readonly canConfirm = computed(
        () =>
            this.selected() !== null && this.preview() !== null && !this.previewLoading() && !this.applying(),
    );

    constructor() {
        // Opening loads the catalogue; closing resets, so reopening never shows the numbers from
        // the plan somebody looked at and decided against.
        effect(() => {
            const open = this.visible();
            untracked(() => {
                if (!open) {
                    this.reset();
                    return;
                }
                if (this.plans().length === 0 && this.catalogueError() === null) this.loadCatalogue();
            });
        });
    }

    protected loadCatalogue(): void {
        this.catalogueLoading.set(true);
        this.catalogueError.set(null);
        this.billing.getCatalogue().subscribe({
            next: catalogue => {
                this.plans.set(catalogue.plans ?? []);
                this.catalogueLoading.set(false);
            },
            error: err => {
                this.plans.set([]);
                this.catalogueError.set(refusal(err));
                this.catalogueLoading.set(false);
            },
        });
    }

    /** Picking a plan is what asks for its proration. Picking another asks again. */
    protected select(plan: BillingPlanDto): void {
        if (this.applying()) return;
        if (this.selected()?.name === plan.name) return;

        this.selected.set(plan);
        this.applyError.set(null);
        this.runPreview(plan);
    }

    /** After a preview that failed. The selection is still theirs; only the request went wrong. */
    protected retryPreview(): void {
        const plan = this.selected();
        if (plan) this.runPreview(plan);
    }

    protected confirm(): void {
        const plan = this.selected();
        if (!plan || !this.canConfirm()) return;

        this.applying.set(true);
        this.applyError.set(null);
        this.billing.changePlan(this.subscription().id, {planName: plan.name}).subscribe({
            next: updated => {
                this.applying.set(false);
                this.applied.set(updated);

                // A plan change moves ceilings, which is what makes this the one action on these
                // screens that has to drop what the store is holding.
                const subject = this.subject();
                this.entitlements.invalidate(subject);
                this.entitlements.ensureLoaded(subject);

                this.changed.emit(updated);
            },
            error: err => {
                this.applying.set(false);
                this.applyError.set(refusal(err));
            },
        });
    }

    /** Closes, unless the change is being applied. */
    protected close(): void {
        if (this.applying()) return;
        this.visible.set(false);
    }

    /** The header button, Escape and the backdrop all arrive here, and none of them outrank a charge. */
    protected onVisibleChange(visible: boolean): void {
        if (visible) {
            this.visible.set(true);
            return;
        }
        this.close();
    }

    private runPreview(plan: BillingPlanDto): void {
        const token = ++this.previewToken;
        this.previewLoading.set(true);
        this.previewError.set(null);
        this.preview.set(null);

        this.billing.previewChange(this.subscription().id, {planName: plan.name}).subscribe({
            next: preview => {
                if (token !== this.previewToken) return;
                this.preview.set(preview);
                this.previewLoading.set(false);
            },
            error: err => {
                if (token !== this.previewToken) return;
                this.previewError.set(refusal(err));
                this.previewLoading.set(false);
            },
        });
    }

    private reset(): void {
        this.previewToken++;
        // The catalogue itself survives a close - it is the same list next time - but a catalogue
        // that would not load must be retried on reopen rather than remembered as broken.
        this.catalogueError.set(null);
        this.selected.set(null);
        this.preview.set(null);
        this.previewLoading.set(false);
        this.previewError.set(null);
        this.applying.set(false);
        this.applyError.set(null);
        this.applied.set(null);
    }
}

function refusal(err: unknown): Refusal {
    const copy = billingErrorCopy(err);
    return {key: copy.key, text: copy.text};
}
