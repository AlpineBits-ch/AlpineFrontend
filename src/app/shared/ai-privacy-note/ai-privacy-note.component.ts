import {Component, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/**
 * What happens to an AI provider key, stated wherever one is asked for.
 *
 * One component rather than the same paragraph typed into the settings page and the in-wiki
 * connect panel: this is the single thing a user has to trust before handing over a credential
 * that spends their money, and two copies of it would drift the first time either is edited.
 *
 * Rendered in normal body text on purpose. Fine print reads as a disclaimer somebody was obliged
 * to include; this is the actual answer to the question the user is asking.
 */
@Component({
    selector: 'app-ai-privacy-note',
    imports: [TranslateModule],
    template: `
        <div class="flex gap-3 rounded-xl border border-brand/25 bg-brand/[0.06] px-4 py-3">
            <i class="pi pi-lock mt-0.5 shrink-0 text-[0.875rem] text-brand-dim"></i>
            <div class="min-w-0">
                <p class="text-sm font-semibold text-text-primary">
                    {{ 'AI.PRIVACY.TITLE' | translate }}
                </p>
                <p class="mt-1 text-sm leading-relaxed text-text-secondary">
                    {{ 'AI.PRIVACY.BODY' | translate }}
                </p>
                @if (showBilling()) {
                    <p class="mt-1.5 text-sm leading-relaxed text-text-secondary">
                        {{ 'AI.PRIVACY.BILLING' | translate }}
                    </p>
                }
            </div>
        </div>
    `,
})
export class AiPrivacyNoteComponent {
    /** The billing sentence is noise in a dialog you reached by clicking Generate. */
    readonly showBilling = input(true);
}
