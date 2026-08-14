import {Component, computed, effect, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {EntitlementStore} from '../../../../stores/entitlement.store';
import {entitlementRemedyCopy, moduleNotInPlanCopy} from '../../../../core/entitlement-message';

/**
 * The third module empty state: the guild's plan does not cover this module.
 *
 * <p><b>A third state, not a rewording of either existing one.</b> A module screen already draws
 * "the owner turned it off" and "you cannot see this", and this is neither: the owner asked for the
 * module and holds every permission, and no toggle in this guild will produce it. All three arrive
 * as the same empty room and only `withheldByPlan` tells them apart, which is why the server sends
 * that list and why deriving it from what is effective would be the mistake worth building a
 * component to prevent.</p>
 *
 * <p>Hosts keep their own off-state markup. It is module-specific copy that already exists, it is
 * already covered by `i18n-keys.spec.ts` as a literal in their templates, and moving it behind an
 * attribute binding here would quietly take it out of that guard's reach.</p>
 *
 * <p><b>Nothing here says the content is gone.</b> Nothing is deleted on a downgrade - a guild that
 * loses a module loses access to what it holds, not the rows - and the intended end state is
 * read-only access rather than a refusal, so the copy is written for that to be a rendering change
 * later and not a redesign.</p>
 */
@Component({
    selector: 'app-module-not-in-plan',
    imports: [TranslateModule],
    templateUrl: './module-not-in-plan.component.html',
})
export class ModuleNotInPlanComponent {
    /** The `GuildFeatures` name, which is what the copy is looked up by. */
    feature = input.required<string>();
    guildId = input.required<string>();

    private entitlements = inject(EntitlementStore);

    protected copy = computed(() => moduleNotInPlanCopy(this.feature()));

    /**
     * Who can do something about it, aimed by the server rather than by this component.
     *
     * <p>Both halves are null until the guild's set has been read, and null for good on an instance
     * that sells nothing: `remedy: "none"` with `actorCanRemedy: false` is what a self-hosted
     * instance answers for every limit. Nothing here re-implements ManageGuild, which is how a
     * client ends up drawing a buy button that 403s.</p>
     */
    protected remedy = computed(() => {
        const snapshot = this.entitlements.snapshot({kind: 'guild', id: this.guildId()});
        return entitlementRemedyCopy(snapshot?.remedy, snapshot?.actorCanRemedy === true);
    });

    constructor() {
        // Only this component reads the guild's ceilings, and it only exists on the rare screen
        // that is actually withheld - so the request is not paid by every module screen on every
        // instance for a sentence that never mentions a plan.
        effect(() => this.entitlements.ensureLoaded({kind: 'guild', id: this.guildId()}));
    }
}
