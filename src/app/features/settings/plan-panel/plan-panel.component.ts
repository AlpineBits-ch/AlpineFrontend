import {Component, computed, effect, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {EntitlementStore, EntitlementSubjectRef} from '../../../stores/entitlement.store';
import {entitlementRemedyCopy} from '../../../core/entitlement-message';
import {guildFeatureLabelKey} from '../../guild/guild-features';
import {PlanPickerComponent} from '../../billing/plan-picker/plan-picker.component';
import {PaymentMethodsComponent} from '../../billing/payment-methods/payment-methods.component';
import {SubscriptionCardComponent} from '../../billing/subscription-card/subscription-card.component';
import {InvoiceListComponent} from '../../billing/invoice-list/invoice-list.component';

/**
 * What plan a subject is on, for the one screen where they would change it.
 *
 * <p>One component for both subjects, because "what am I on" is the same question about an account
 * and about a server and the two answers arrive in the same shape. The `subject` input is the only
 * difference, and it is what makes the guild page show the guild's plan rather than the reader's.
 * </p>
 *
 * <p><b>Nothing here invents a plan.</b> `plan` is absent on an instance with none configured and
 * on every self-hosted one, and that is a real state: those resolve every key to its default and
 * have no plan to name. A "Free" row substituted here would put a tier boundary on the screen of
 * somebody nobody is charging - see `EntitlementPlanDto`. The host hides this page entirely when
 * the instance sells nothing (guide section 5.3, hidden and not disabled), so what is drawn on the
 * no-plan path is only ever seen on an instance that does sell something and has not put this
 * subject on anything.</p>
 */
@Component({
    selector: 'app-plan-panel',
    imports: [
        TranslateModule,
        PlanPickerComponent,
        PaymentMethodsComponent,
        SubscriptionCardComponent,
        InvoiceListComponent,
    ],
    templateUrl: './plan-panel.component.html',
})
export class PlanPanelComponent {
    subject = input.required<EntitlementSubjectRef>();

    private entitlements = inject(EntitlementStore);

    protected snapshot = computed(() => this.entitlements.snapshot(this.subject()));

    /** Null both when no set is held and when the server named no plan; neither names a tier. */
    protected plan = computed(() => this.entitlements.plan(this.subject()));

    /**
     * The version this subject's numbers actually came from.
     *
     * <p>Rendered rather than hidden, which is where this parts company with the frontend guide's
     * "not a thing to put next to the plan name". The server grandfathers a subject onto the
     * version they bought, so a guild can be resolving `plus@2` while version 4 is what is on sale -
     * and showing only "Plus" hides from exactly that population that they are on older terms. The
     * number plus the `PLAN.VERSION_NOTE` sentence beside it is what makes that legible.</p>
     *
     * <p><b>It cannot say "this is not the current version", and deliberately does not try.</b> The
     * snapshot carries one version and no statement of which is current: the server fills this
     * field with the pin for a pinned subject and with the catalogue's current version for everyone
     * else, so the two are indistinguishable here. Guessing would be worse than the number.</p>
     */
    protected planVersion = computed(() => this.plan()?.version ?? null);

    /** The instance's own answer to "can this reader do anything about it", never computed here. */
    protected remedy = computed(() => {
        const snapshot = this.snapshot();
        return entitlementRemedyCopy(snapshot?.remedy, snapshot?.actorCanRemedy === true);
    });

    /**
     * The modules the guild's owner asked for and is not getting.
     *
     * <p>`withheldByPlan` as sent, not derived from `effective`: an empty list is the normal case
     * and is what makes this safe to draw unconditionally - a non-empty one is always an upgrade
     * prompt and never a scold.</p>
     */
    protected withheldModules = computed(() => {
        const guildId = this.guildId();
        if (!guildId) return [];
        return (this.entitlements.features(guildId)?.withheldByPlan ?? [])
            .map(module => ({module, labelKey: guildFeatureLabelKey(module)}));
    });

    private guildId = computed(() => {
        const subject = this.subject();
        return subject.kind === 'guild' ? subject.id : null;
    });

    /**
     * Whether the cards on file belong on this screen.
     *
     * <p>They are an account's, never a guild's: a guild subscription is paid for by whichever
     * person bought it, and the cards behind it are theirs. A guild plan page listing somebody's
     * cards to every admin who can open it would be the same mistake in the other direction.</p>
     */
    protected isOwnAccount = computed(() => this.subject().kind === 'user');

    constructor() {
        effect(() => {
            const subject = this.subject();
            this.entitlements.ensureLoaded(subject);
            if (subject.kind === 'guild') this.entitlements.ensureFeaturesLoaded(subject.id);
        });
    }
}
