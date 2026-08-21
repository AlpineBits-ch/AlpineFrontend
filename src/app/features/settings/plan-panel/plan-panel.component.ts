import {ChangeDetectionStrategy, Component, computed, effect, inject, input, viewChild} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {entitlementRemedyCopy} from '../../../core/entitlement-message';
import {guildFeatureLabelKey} from '../../guild/guild-features';
import {PlanPickerComponent} from '../../billing/plan-picker/plan-picker.component';
import {PaymentMethodsComponent} from '../../billing/payment-methods/payment-methods.component';
import {SubscriptionCardComponent} from '../../billing/subscription-card/subscription-card.component';
import {InvoiceListComponent} from '../../billing/invoice-list/invoice-list.component';
import {CreditPanelComponent} from '../../billing/credit-panel/credit-panel.component';

/** What plan a subject is on, for the one screen where they would change it. */
@Component({
    selector: 'app-plan-panel',
    imports: [
        TranslateModule,
        PlanPickerComponent,
        PaymentMethodsComponent,
        SubscriptionCardComponent,
        InvoiceListComponent,
        CreditPanelComponent,
    ],
    templateUrl: './plan-panel.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanPanelComponent {
    readonly subject = input.required<EntitlementSubjectRef>();

    private entitlements = inject(EntitlementStore);

    /** The card that owns the change dialog, for the refusal the plan picker cannot answer itself. */
    private readonly subscriptionCard = viewChild(SubscriptionCardComponent);

    protected readonly snapshot = computed(() => this.entitlements.snapshot(this.subject()));

    /** Null both when no set is held and when the server named no plan; neither names a tier. */
    protected readonly plan = computed(() => this.entitlements.plan(this.subject()));

    /** The version this subject's numbers actually came from. */
    protected readonly planVersion = computed(() => this.plan()?.version ?? null);

    /** The instance's own answer to "can this reader do anything about it", never computed here. */
    protected readonly remedy = computed(() => {
        const snapshot = this.snapshot();
        return entitlementRemedyCopy(snapshot?.remedy, snapshot?.actorCanRemedy === true);
    });

    /** The modules the guild's owner asked for and is not getting. */
    protected readonly withheldModules = computed(() => {
        const guildId = this.guildId();
        if (!guildId) return [];
        return (this.entitlements.features(guildId)?.withheldByPlan ?? []).map(module => ({
            module,
            labelKey: guildFeatureLabelKey(module),
        }));
    });

    private readonly guildId = computed(() => {
        const subject = this.subject();
        return subject.kind === 'guild' ? subject.id : null;
    });

    /** Whether the cards on file belong on this screen. */
    protected readonly isOwnAccount = computed(() => this.subject().kind === 'user');

    /** A buy that was refused because this subject already has a subscription. */
    protected onChangePlanRequested(): void {
        this.subscriptionCard()?.requestChangePlan();
    }

    constructor() {
        effect(() => {
            const subject = this.subject();
            this.entitlements.ensureLoaded(subject);
            if (subject.kind === 'guild') this.entitlements.ensureFeaturesLoaded(subject.id);
        });
    }
}
