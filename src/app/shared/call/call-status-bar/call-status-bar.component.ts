import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallStatus, CallStatusTone, resolveCallStatus} from '../call-status';

/**
 * The one row that reports how a call is doing.
 *
 * <p>Replaces the DM panel's `.status-bar` plus its three `.conn-banner` variants and the guild
 * channel's three stacked banner blocks - two implementations of the same idea that agreed on
 * neither padding, type size, nor colour. See call-status.ts for why it is one row and not a
 * stack.</p>
 *
 * <p>Always rendered, including when everything is fine, so the stage below it never changes
 * height because a warning arrived.</p>
 */
@Component({
    selector: 'app-call-status-bar',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    template: `
        @let s = status();
        <div [class]="rowClass()" aria-live="polite" role="status">
            <span [class]="dotClass()"></span>

            <span [class]="labelClass()">{{ s.labelKey | translate }}</span>

            @if (s.detailKey; as detail) {
                <span class="text-white/25" aria-hidden="true">·</span>
                <span class="min-w-0 truncate text-white/60">
                    {{ detail | translate: s.detailParams ?? {} }}
                </span>
            } @else if (meta(); as m) {
                <span class="text-white/25" aria-hidden="true">·</span>
                <span class="shrink-0 tabular-nums text-white/55">{{ m }}</span>
            }

            <!-- Trailing controls: the stats toggle and the panel's maximise button. -->
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <ng-content />
            </div>
        </div>
    `,
})
export class CallStatusBarComponent {
    /** `RTCPeerConnection.connectionState` as reported by the owning service. */
    readonly rtcState = input.required<string>();
    /** At least one remote participant is past the audio grace window. */
    readonly stalledAudio = input(false);
    /** Formatted wall-clock time this call is about to be ended at, or null. */
    readonly aloneUntil = input<string | null>(null);
    /**
     * Free text shown after the label while the call is healthy - the DM panel's elapsed time, the
     * guild channel's participant count. Dropped the moment there is something wrong to say
     * instead, because the problem is the more useful of the two.
     */
    readonly meta = input<string | null>(null);

    protected readonly status = computed((): CallStatus =>
        resolveCallStatus({
            rtcState: this.rtcState(),
            stalledAudio: this.stalledAudio(),
            aloneUntil: this.aloneUntil(),
        }),
    );

    protected readonly rowClass = computed(() => {
        const tone = this.status().tone;
        const tint =
            tone === 'error'
                ? 'bg-offline/[0.10] border-offline/25'
                : tone === 'warn'
                  ? 'bg-connecting/[0.08] border-connecting/25'
                  : 'border-border-subtle';

        return `flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs ${tint}`;
    });

    protected readonly labelClass = computed(
        () => `shrink-0 font-semibold uppercase tracking-wide ${textFor(this.status().tone)}`,
    );

    protected readonly dotClass = computed(() => {
        const tone = this.status().tone;
        const pulse =
            tone === 'error' ? 'status-pulse status-pulse--urgent' : tone === 'warn' ? 'status-pulse' : '';

        return `size-2 shrink-0 rounded-full ${bgFor(tone)} ${pulse}`;
    });
}

function textFor(tone: CallStatusTone): string {
    if (tone === 'error') return 'text-offline';
    return tone === 'warn' ? 'text-connecting' : 'text-online';
}

function bgFor(tone: CallStatusTone): string {
    if (tone === 'error') return 'bg-offline';
    return tone === 'warn' ? 'bg-connecting' : 'bg-online';
}
