import {ChangeDetectionStrategy, Component, computed, HostListener, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {StreamLayerStats, StreamStatsSnapshot} from '../stream-stats';

/** One rendered line. `value` is pre-formatted; absent fields never reach here. */
interface StatRow {
    key: string;
    testId: string;
    value: string;
    warn?: boolean;
}

interface LayerSection {
    title: string;
    titleArgs: {rid: string};
    rows: StatRow[];
}

/**
 * A live per-stream WebRTC readout, pinned inside a share tile.
 *
 * <p>Purely presentational: it renders whatever snapshot it is given and owns no polling. That is
 * what lets one component serve an inbound stream read off the webview's receive connection and an
 * outbound one merged in Rust, which have different fields available and no common source.</p>
 *
 * <p><b>An absent field renders as no row at all.</b> Never as `0`, and never as a dash: a
 * pipeline that cannot produce a number and a stream genuinely reporting zero are different
 * findings, and this panel exists to tell them apart. This is achieved entirely by the
 * `!== undefined` guards in `rowsFor` below, not by branching on `source` - the panel does not
 * know or care which pipeline filled the snapshot in, only which fields it finds set. `source` is
 * carried on the snapshot as metadata for the raw-copy clipboard payload, not consulted here. See
 * the doc on `StreamStatsSnapshot`.</p>
 *
 * <p><b>Dismissal is copied from `CallStreamMenuComponent`, and the three parts are one
 * mechanism.</b> A document click closes the panel, Escape closes it, and the host's own click
 * handler stops propagation so that a press <em>inside</em> the panel - the close button, or a
 * drag-select over a number somebody is about to read out - never reaches the document listener and
 * dismisses the thing being read. Losing any one of the three either strands the panel open or
 * makes it impossible to touch.</p>
 *
 * <p>The menu item that opens this panel cannot close it with the same click: the menu stops that
 * click at its own host for exactly this reason, so it never reaches the document, and this
 * component is not in the DOM while that click is being dispatched in any case.</p>
 */
@Component({
    selector: 'app-call-stream-stats',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    templateUrl: './call-stream-stats.component.html',
    host: {'(click)': '$event.stopPropagation()'},
})
export class CallStreamStatsComponent {
    stats = input.required<StreamStatsSnapshot | null>();

    close = output<void>();

    @HostListener('document:click')
    onDocumentClick(): void {
        this.close.emit();
    }

    @HostListener('document:keydown.escape')
    onEscape(): void {
        this.close.emit();
    }

    protected readonly title = computed(() =>
        this.stats()?.direction === 'outbound' ? 'CALL.STATS_NERD.TITLE_OUT' : 'CALL.STATS_NERD.TITLE_IN');

    protected readonly headerRows = computed<StatRow[]>(() => {
        const s = this.stats();
        if (!s) return [];
        const rows: StatRow[] = [];

        if (s.codec) rows.push({key: 'CALL.STATS_NERD.CODEC', testId: 'row-codec', value: s.codec});
        if (s.profileLevelId) {
            rows.push({key: 'CALL.STATS_NERD.PROFILE', testId: 'row-profile', value: s.profileLevelId});
        }

        const t = s.transport;
        if (t?.rttMs !== undefined) {
            rows.push({key: 'CALL.STATS_NERD.RTT', testId: 'row-rtt', value: `${t.rttMs} ms`});
        }
        if (t?.localCandidateType || t?.remoteCandidateType) {
            const path = [t.protocol, t.localCandidateType, t.remoteCandidateType].filter(Boolean).join(' / ');
            rows.push({key: 'CALL.STATS_NERD.PATH', testId: 'row-path', value: path});
        }
        if (t?.availableOutgoingKbps !== undefined) {
            rows.push({
                key: 'CALL.STATS_NERD.AVAILABLE',
                testId: 'row-available',
                value: `${t.availableOutgoingKbps} kbps`,
            });
        }

        return rows;
    });

    protected readonly sections = computed<LayerSection[]>(() =>
        (this.stats()?.layers ?? []).map(layer => ({
            title: layer.rid ? 'CALL.STATS_NERD.LAYER' : 'CALL.STATS_NERD.LAYER_ONLY',
            titleArgs: {rid: layer.rid ?? ''},
            rows: rowsFor(layer),
        })));
}

/**
 * Every field this layer actually carries, in reading order.
 *
 * <p>Each guard is `!== undefined` rather than truthy, which is the whole point: `0` is a value
 * worth showing and `undefined` is not a value at all.</p>
 */
function rowsFor(layer: StreamLayerStats): StatRow[] {
    const rows: StatRow[] = [];

    if (layer.width !== undefined && layer.height !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.SIZE',
            testId: 'row-size',
            value: `${layer.width} x ${layer.height}`,
        });
    }
    if (layer.fps !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.FPS', testId: 'row-fps', value: `${layer.fps}`});
    }
    if (layer.kbps !== undefined) {
        // Shown against the rung's budget when there is one. The pair is the finding: a layer far
        // under its target, or silent, is what a broken simulcast ladder looks like from here.
        const value = layer.targetKbps === undefined
            ? `${layer.kbps} kbps`
            : `${layer.kbps} / ${layer.targetKbps} kbps`;
        rows.push({key: 'CALL.STATS_NERD.BITRATE', testId: 'row-bitrate', value});
    } else if (layer.targetKbps !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.TARGET',
            testId: 'row-target',
            value: `${layer.targetKbps} kbps`,
            // A rung with a budget and no measured rate is the failure signature, not a gap.
            warn: true,
        });
    }
    if (layer.framesEncoded !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.FRAMES_ENCODED', testId: 'row-encoded', value: `${layer.framesEncoded}`,
        });
    }
    if (layer.framesDecoded !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.FRAMES_DECODED', testId: 'row-decoded', value: `${layer.framesDecoded}`,
        });
    }
    if (layer.keyFrames !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.KEYFRAMES', testId: 'row-keyframes', value: `${layer.keyFrames}`});
    }
    if (layer.framesDropped !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.DROPPED',
            testId: 'row-dropped',
            value: `${layer.framesDropped}`,
            warn: layer.framesDropped > 0,
        });
    }
    if (layer.packets !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.PACKETS', testId: 'row-packets', value: `${layer.packets}`});
    }
    if (layer.packetsLost !== undefined) {
        rows.push({
            key: 'CALL.STATS_NERD.PACKETS_LOST',
            testId: 'row-lost',
            value: `${layer.packetsLost}`,
            warn: layer.packetsLost > 0,
        });
    }
    if (layer.nackCount !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.NACK', testId: 'row-nack', value: `${layer.nackCount}`});
    }
    if (layer.pliCount !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.PLI', testId: 'row-pli', value: `${layer.pliCount}`});
    }
    if (layer.jitterMs !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.JITTER', testId: 'row-jitter', value: `${layer.jitterMs} ms`});
    }
    if (layer.qp !== undefined) {
        rows.push({key: 'CALL.STATS_NERD.QP', testId: 'row-qp', value: `${layer.qp}`});
    }
    if (layer.encoder) {
        rows.push({key: 'CALL.STATS_NERD.ENCODER', testId: 'row-encoder', value: layer.encoder});
    }

    return rows;
}
