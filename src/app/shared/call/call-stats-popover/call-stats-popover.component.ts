import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallStats} from '../../../services/call-webrtc.service';

/**
 * Connection statistics, as a labelled panel.
 *
 * <p>This was a monospace strip wedged under the status bar reading
 * `↓ 340 kbps · ↑ 120 kbps · vid ↓ 42k · ✗ 3` - raw arrow and cross glyphs as text, at 10px, in a
 * full-width band that pushed the call down whenever it was open. Nobody but its author could read
 * a row of it, and it is diagnostics: it belongs behind its toggle, not in the layout.</p>
 */
@Component({
    selector: 'app-call-stats-popover',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    template: `
        <div
            class="absolute right-3 top-full z-30 mt-1 w-56 rounded-xl border border-border bg-card p-3
                    shadow-[0_8px_28px_rgba(0,0,0,0.55)]"
        >
            <p class="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-white/40">
                {{ 'CALL.STATS_TITLE' | translate }}
            </p>

            <dl class="flex flex-col gap-1.5 text-xs">
                @for (row of rows(); track row.key) {
                    <div class="flex items-baseline justify-between gap-3">
                        <dt class="min-w-0 truncate text-white/55">{{ row.key | translate }}</dt>
                        <dd
                            [class]="
                                'shrink-0 tabular-nums ' + (row.warn ? 'text-connecting' : 'text-white/85')
                            "
                        >
                            {{ row.value }}
                        </dd>
                    </div>
                }
            </dl>
        </div>
    `,
})
export class CallStatsPopoverComponent {
    readonly stats = input.required<CallStats>();

    protected readonly rows = computed(() => {
        const s = this.stats();
        const kbps = (n: number) => `${n} kbps`;

        const rows: {key: string; value: string; warn?: boolean}[] = [
            {key: 'CALL.STATS.DOWNLOAD', value: kbps(s.inboundKbps)},
            {key: 'CALL.STATS.UPLOAD', value: kbps(s.outboundKbps)},
        ];

        // Video lines only exist when video does - a call with no camera and no share would
        // otherwise show two permanent zeroes.
        if (s.inboundVideoKbps > 0)
            rows.push({key: 'CALL.STATS.VIDEO_DOWN', value: kbps(s.inboundVideoKbps)});
        if (s.outboundVideoKbps > 0)
            rows.push({key: 'CALL.STATS.VIDEO_UP', value: kbps(s.outboundVideoKbps)});
        if (s.packetsLost > 0) {
            rows.push({key: 'CALL.STATS.PACKETS_LOST', value: `${s.packetsLost}`, warn: true});
        }

        return rows;
    });
}
