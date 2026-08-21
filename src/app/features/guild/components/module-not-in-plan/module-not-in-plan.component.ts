import {ChangeDetectionStrategy, Component, computed, effect, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {EntitlementStore} from '../../../../stores/entitlement.store';
import {entitlementRemedyCopy, moduleNotInPlanCopy} from '../../../../core/entitlement-message';

/** The third module empty state: only the server's `withheldByPlan` list distinguishes it from "owner turned it off" and "you cannot see this"; never derive it from what is effective. */
@Component({
    selector: 'app-module-not-in-plan',
    imports: [TranslateModule],
    templateUrl: './module-not-in-plan.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModuleNotInPlanComponent {
    /** The `GuildFeatures` name, which is what the copy is looked up by. */
    readonly feature = input.required<string>();
    readonly guildId = input.required<string>();

    private entitlements = inject(EntitlementStore);

    protected readonly copy = computed(() => moduleNotInPlanCopy(this.feature()));

    /** Aimed by the server, never by re-implementing ManageGuild here: that is how a client ends up drawing a buy button that 403s. */
    protected readonly remedy = computed(() => {
        const snapshot = this.entitlements.snapshot({kind: 'guild', id: this.guildId()});
        return entitlementRemedyCopy(snapshot?.remedy, snapshot?.actorCanRemedy === true);
    });

    constructor() {
        effect(() => this.entitlements.ensureLoaded({kind: 'guild', id: this.guildId()}));
    }
}
