import {ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenShare} from '../call.types';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {CallLiveBadgeComponent} from '../call-live-badge/call-live-badge.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';

const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

/**
 * One screen share, with its own zoom, pan and window controls.
 *
 * <p>Pulled out of call-screen-layout, which rendered this inline inside an `@for` and therefore
 * had to find the tile a button belonged to by walking up the DOM: `closest('.share-tile')` for
 * fullscreen and, in the same file, `closest('.relative')` for picture-in-picture - which resolved
 * to whichever ancestor happened to be positioned. One component per tile means an element
 * reference instead of a guess.</p>
 *
 * <p>Zoom and pan live here for the same reason. The parent kept them in two dictionaries keyed by
 * share id and never read either outside this markup.</p>
 */
@Component({
    selector: 'app-call-share-tile',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, StreamSrcDirective, CallLiveBadgeComponent, CallTileActionComponent],
    templateUrl: './call-share-tile.component.html',
    host: {class: 'contents'},
})
export class CallShareTileComponent {
    share = input.required<CallScreenShare>();
    /** People watching this stream, this client included. Zero renders nothing - see the template. */
    viewers = input(0);
    /** Whether this tile is currently the only one the layout is showing. */
    maximized = input(false);

    maximizeToggle = output<void>();
    audioToggle = output<void>();

    protected readonly root = viewChild.required<ElementRef<HTMLElement>>('root');
    protected readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

    protected readonly zoom = signal(1);
    protected readonly pan = signal({x: 0, y: 0});

    protected readonly transform = computed(() => {
        const {x, y} = this.pan();
        return `translate(${x}px, ${y}px) scale(${this.zoom()})`;
    });

    protected readonly label = computed(() => {
        const s = this.share();
        return {name: s.displayName};
    });

    private dragging: {startX: number; startY: number; originX: number; originY: number} | null = null;

    protected zoomIn(): void {
        this.zoom.update(z => z < MAX_ZOOM ? +(z + ZOOM_STEP).toFixed(2) : z);
    }

    protected zoomOut(): void {
        const next = Math.max(1, +(this.zoom() - ZOOM_STEP).toFixed(2));
        this.zoom.set(next);
        // Back at 1x the content fits the tile again, so a pan offset could only push it off-centre
        // with no way to see what it hid.
        if (next === 1) this.pan.set({x: 0, y: 0});
    }

    /** Panning only means anything once the content is larger than its tile. */
    protected startPan(event: MouseEvent): void {
        if (this.zoom() <= 1) return;
        event.preventDefault();
        const origin = this.pan();
        this.dragging = {
            startX: event.clientX,
            startY: event.clientY,
            originX: origin.x,
            originY: origin.y,
        };
    }

    protected movePan(event: MouseEvent): void {
        const drag = this.dragging;
        if (!drag) return;
        this.pan.set({
            x: drag.originX + (event.clientX - drag.startX),
            y: drag.originY + (event.clientY - drag.startY),
        });
    }

    protected endPan(): void {
        this.dragging = null;
    }

    /**
     * Fullscreens the tile rather than the &lt;video&gt;, so the name pill, the LIVE badge and the
     * viewer count go with it. Distinct from maximise, which only stops the *other* tiles being
     * rendered - the pane and the rest of the app stay exactly where they were, which is not what
     * anybody means by fullscreen.
     */
    protected toggleFullscreen(): void {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => void 0);
        else void this.root().nativeElement.requestFullscreen().catch(() => void 0);
    }

    protected togglePip(): void {
        const video = this.video()?.nativeElement;
        if (!video || !document.pictureInPictureEnabled) return;
        if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => void 0);
        else void video.requestPictureInPicture().catch(() => void 0);
    }
}
