import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenShare} from '../call.types';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {CallLiveBadgeComponent} from '../call-live-badge/call-live-badge.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';
import {videoPipSupported} from '../pip-support';
import {RustMediaService} from '../../../services/rust-media.service';

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
    /**
     * Who those viewers are, already resolved to display names. Empty is not the same as "unknown" -
     * it just means the layout has not been given a way to resolve names, or the names are still
     * loading - so the template falls back to the plain count tooltip rather than an empty popover.
     */
    viewerNames = input<string[]>([]);
    /** Whether this tile is currently the only one the layout is showing. */
    maximized = input(false);

    maximizeToggle = output<void>();
    audioToggle = output<void>();
    /** Drop this share from the layout - see the doc on `CallScreenLayoutComponent.hideShare`. Not
     *  offered for the local share: the watch claim it would shrink never counted the local share in
     *  the first place, so "stop watching" would be asking to hide your own output, not to drop
     *  someone else's stream. */
    hide = output<void>();

    protected readonly root = viewChild.required<ElementRef<HTMLElement>>('root');
    protected readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

    private readonly rustMedia = inject(RustMediaService);

    /**
     * Whether this tile is the thing putting the local preview image on screen right now.
     *
     * <p>Scoped to the `previewSrc` branch specifically - see the template - because a browser
     * session's local tile shows a real `MediaStream` instead (the `s.stream` branch), and Task
     * 10's idle pause has nothing to apply to there: `RustMediaService.publishPreview` never has
     * anything in it on that path.</p>
     */
    protected readonly showingLocalPreview = computed(() => {
        const s = this.share();
        return s.isLocal && !s.stream && !!s.previewSrc;
    });

    /** Paused only means anything while this tile is the one actually showing the preview. */
    protected readonly previewPaused = computed(() => this.showingLocalPreview() && this.rustMedia.previewPaused());

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

    /**
     * Whether the PiP button can do anything at all.
     *
     * <p>`togglePip()` only ever does video-element PiP, so that is all this may claim: a real
     * `MediaStream` to bind a `<video>` to, and the environment actually supporting video PiP. A
     * local share with no stream (the Rust-published desktop path, see `CallScreenShare.previewSrc`)
     * has nothing to hand it regardless of what else the environment can do - document PiP could
     * carry the `<img>` preview instead, but nothing here dispatches that yet, so advertising it
     * would be the same dead button this task exists to remove. That is Task 9's to add, alongside
     * widening this check. Read lazily through pip-support.ts rather than cached, so a capability
     * that only appears later - or a test stub - is picked up on the next read instead of the
     * first one.</p>
     */
    protected readonly canPip = computed(() => videoPipSupported() && !!this.share().stream);

    private dragging: {startX: number; startY: number; originX: number; originY: number} | null = null;

    constructor() {
        // Claims "somebody is rendering the preview" for Task 10's idle pause - see
        // RustMediaService.claimPreviewRender. onCleanup releases it the moment showingLocalPreview
        // goes false, whether that is because this tile stopped being the local one, the share
        // ended, or the component was destroyed outright - all three have to release, or the idle
        // timer would never start while nobody could actually see the frames it is burning.
        effect(onCleanup => {
            if (!this.showingLocalPreview()) return;
            this.rustMedia.claimPreviewRender(this);
            onCleanup(() => this.rustMedia.releasePreviewRender(this));
        });
    }

    /** The resume button on the paused card, and any other interaction with it. */
    protected resumePreview(): void {
        this.rustMedia.resumePreview();
    }

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
        if (!video || !videoPipSupported()) return;
        if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => void 0);
        else void video.requestPictureInPicture().catch(() => void 0);
    }
}
