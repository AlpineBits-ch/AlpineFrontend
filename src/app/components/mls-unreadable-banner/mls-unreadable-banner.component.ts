import {Component, computed, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {MlsFailureReason, MlsHealthService} from '../../services/mls-health.service';

/**
 * Says, in the conversation it applies to, that this device cannot read it - and offers the one
 * action that fixes it.
 *
 * <p>This surface is the point of the whole failure-reporting change. Every one of these states
 * used to be a `console.error` or a bare `catch {}`, so a device that could never join a
 * conversation logged one line per launch and showed its owner nothing. The only symptom anyone
 * could report was "sometimes messages don't arrive", which is why the underlying bug shipped and
 * stayed shipped.</p>
 *
 * <p>Deliberately quiet until a context is genuinely broken: one decrypt failure is ordinary,
 * because a message paged in from beyond the ratchet's reach can never be decrypted and that is
 * correct MLS behaviour rather than a fault.</p>
 */
@Component({
    selector: 'app-mls-unreadable-banner',
    standalone: true,
    imports: [Button],
    template: `
        @if (visible()) {
            <div class="mx-4 mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30
                        bg-amber-500/[0.08] px-4 py-3">
                <i class="pi pi-lock-open text-amber-300 text-[0.875rem] shrink-0 mt-0.5"></i>
                <div class="min-w-0 flex-1">
                    <p class="m-0 text-[0.8125rem] text-text-primary">{{ title() }}</p>
                    <p class="m-0 mt-0.5 text-xs text-text-muted">{{ detail() }}</p>
                </div>
                <p-button (onClick)="relink.emit(contextId())" [text]="true" label="Re-link device"
                          severity="warn" size="small"/>
            </div>
        }
    `,
})
export class MlsUnreadableBannerComponent {
    readonly contextId = input.required<string>();
    /** Raised when the user asks to re-link. The host decides what that means. */
    readonly relink = output<string>();

    private readonly health = inject(MlsHealthService);

    protected readonly visible = computed(() => this.health.isBroken(this.contextId()));

    protected readonly title = computed(() => {
        switch (this.reason()) {
            case 'removed':
                return 'This device was removed from the conversation';
            case 'not-admitted':
                return 'This device has not been added to the conversation';
            case 'join-failed':
                return 'This device could not join the conversation';
            default:
                return 'This device cannot read this conversation';
        }
    });

    protected readonly detail = computed(() => {
        switch (this.reason()) {
            case 'removed':
                // Correct MLS behaviour, and it must read as deliberate rather than as breakage.
                return 'Messages sent from now on are encrypted to a group this device is no longer in.';
            case 'not-admitted':
                return 'Someone already in the conversation has to admit this device before it can '
                    + 'read anything sent here.';
            case 'join-failed':
                return 'The invitation for this device could not be used. Re-linking mints fresh '
                    + 'keys and asks to be admitted again.';
            default:
                return 'Recent messages could not be decrypted on this device.';
        }
    });

    private readonly reason = computed<MlsFailureReason | null>(
        () => this.health.healthOf(this.contextId())?.reason ?? null,
    );
}
