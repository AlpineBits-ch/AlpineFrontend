import {ChangeDetectionStrategy, Component, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';

/**
 * A peer tile beside a lone participant, shaped like `app-call-participant-tile` so it sits in the
 * stage grid rather than fighting it - same `aspect-video`, same rounded border. It exists so a
 * one-person channel does not look like half an empty room, and so inviting somebody is one click
 * from the stage the caller is already looking at, rather than a menu two levels away.
 *
 * <p>Layout only. There is no invite mechanic behind {@link invite} yet - see
 * `CallScreenLayoutComponent`, which renders this tile without listening to it. A wired handler
 * belongs to whichever task actually builds the invite flow.</p>
 */
@Component({
    selector: 'app-call-invite-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, Button],
    template: `
        <div class="relative flex aspect-video w-full flex-col items-center justify-center gap-4
                    overflow-hidden rounded-2xl border border-border-subtle p-4"
             style="background: radial-gradient(circle at 50% 32%,
                        color-mix(in srgb, var(--color-brand) 20%, transparent) 0%,
                        transparent 65%),
                    linear-gradient(160deg,
                        color-mix(in srgb, var(--color-brand-dark) 38%, var(--color-card)) 0%,
                        var(--color-card) 100%)">

            <!-- Decorative only, and deliberately not the reference's illustration - see the class
                 doc. A single oversized, low-contrast PrimeIcon does the same "fill the empty tile"
                 job as artwork without needing an asset. -->
            <i aria-hidden="true" class="pi pi-users text-[7rem] text-white/[0.06]"></i>

            <div class="flex flex-col items-center gap-3">
                <p class="max-w-[14rem] text-center text-[0.6875rem] text-white/50">
                    {{ 'CALL.INVITE_TO_VOICE_HINT' | translate }}
                </p>
                <p-button (onClick)="invite.emit()"
                          [label]="'CALL.INVITE_TO_VOICE' | translate"
                          icon="pi pi-user-plus"
                          severity="primary"
                          size="small"/>
            </div>
        </div>
    `,
})
export class CallInviteCardComponent {
    /** Not consumed anywhere yet - see the class doc. */
    invite = output<void>();
}
