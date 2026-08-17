import {ChangeDetectionStrategy, Component, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';

/**
 * A peer tile beside a lone participant, shaped like `app-call-participant-tile` so it sits in the
 * stage grid rather than fighting it - same `aspect-video`, same rounded border. It exists so a
 * one-person channel does not look like half an empty room, and so inviting somebody is one click
 * from the stage the caller is already looking at, rather than a menu two levels away.
 *
 * <p>Still layout only, but {@link invite} is wired now. `CallScreenLayoutComponent` re-emits it as
 * `inviteRequested`, carrying the channel it belongs to, and the guild voice channel opens the
 * target picker on it.</p>
 *
 * <p>What it starts is the ephemeral <b>ring</b>: a 60-second invitation to one named member who is
 * already in the guild, which grants nothing and expires whether or not anybody looks at it. It is
 * not the join link, which is a credential anybody can paste anywhere and lives in guild settings.
 * That is also why the tile appears only inside a guild voice channel - a DM call has no ring.</p>
 */
@Component({
    selector: 'app-call-invite-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, Button],
    template: `
        <div
            class="relative flex aspect-video w-full flex-col items-center justify-center gap-4
                    overflow-hidden rounded-2xl border border-border-subtle p-4"
            style="background: radial-gradient(circle at 50% 32%,
                        color-mix(in srgb, var(--color-brand) 20%, transparent) 0%,
                        transparent 65%),
                    linear-gradient(160deg,
                        color-mix(in srgb, var(--color-brand-dark) 38%, var(--color-card)) 0%,
                        var(--color-card) 100%)"
        >
            <!-- Decorative only, and deliberately not the reference's illustration - see the class
                 doc. A single oversized, low-contrast PrimeIcon does the same "fill the empty tile"
                 job as artwork without needing an asset. -->
            <i aria-hidden="true" class="pi pi-users text-[7rem] text-white/[0.06]"></i>

            <div class="flex flex-col items-center gap-3">
                <p class="max-w-[14rem] text-center text-[0.6875rem] text-text-secondary">
                    {{ 'CALL.INVITE_TO_VOICE_HINT' | translate }}
                </p>
                <p-button
                    (onClick)="invite.emit()"
                    [label]="'CALL.INVITE_TO_VOICE' | translate"
                    icon="pi pi-user-plus"
                    severity="primary"
                    size="small"
                />
            </div>
        </div>
    `,
})
export class CallInviteCardComponent {
    /** Opens the ring target picker. See the class doc for what a ring is and is not. */
    invite = output<void>();
}
