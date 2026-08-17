import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenShare, shareTile} from '../call.types';
import {WatchScope} from '../../../services/share-watch.service';
import {trackTileHeight} from '../tile-height';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {CallLiveBadgeComponent} from '../call-live-badge/call-live-badge.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';
import {trackActivationClick} from '../activation-click';
import {documentPipApi, videoPipSupported} from '../pip-support';
import {RustMediaService} from '../../../services/rust-media.service';
import {CallStreamMenuComponent} from '../call-stream-menu/call-stream-menu.component';
import {CallStreamStatsComponent} from '../call-stream-stats/call-stream-stats.component';
import {StreamStatsSnapshot} from '../stream-stats';

const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

/** Fallback pop-out size, used when the tile has no measurable box yet. 16:9, the shape of a share. */
const POP_OUT_FALLBACK = {width: 960, height: 540};

/** How long "Copy raw stats" waits for a first snapshot when the panel was never opened. */
const COPY_WAIT_MS = 2000;

/** How often that wait re-reads the snapshot signal. Well under a poll's own 1s cadence. */
const COPY_POLL_MS = 100;

/** How long the copy result stays on the tile before fading out of the way of the picture. */
const COPY_NOTICE_MS = 2500;

/** Which kind of picture-in-picture this tile can actually perform, if any. */
type PipRoute = 'document' | 'video';

/** One screen share, with its own zoom, pan and window controls. */
@Component({
    selector: 'app-call-share-tile',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        TranslateModule,
        StreamSrcDirective,
        CallLiveBadgeComponent,
        CallTileActionComponent,
        CallStreamMenuComponent,
        CallStreamStatsComponent,
    ],
    templateUrl: './call-share-tile.component.html',
    host: {class: 'contents'},
})
export class CallShareTileComponent implements OnDestroy {
    readonly share = input.required<CallScreenShare>();
    /** People watching this stream, this client included. Zero renders nothing - see the template. */
    readonly viewers = input(0);
    /** Who those viewers are, already resolved to display names. */
    readonly viewerNames = input<string[]>([]);
    /** Whether this tile is currently the only one the layout is showing. */
    readonly maximized = input(false);
    /** Which room this share belongs to, so its rendered size can be reported to {@link trackTileHeight}. */
    readonly tileScope = input<WatchScope | null>(null);

    maximizeToggle = output<void>();
    audioToggle = output<void>();
    /** Drop this share from the layout. Not offered for the local share. */
    hide = output<void>();

    /** Resolves this tile's inbound statistics, if the host has any. */
    readonly inboundStatsOf = input<(share: CallScreenShare) => StreamStatsSnapshot | null>(() => null);

    /** The share whose panel is now open, or null when it closed. */
    statsInspect = output<CallScreenShare | null>();

    /** Where the right-click landed, in viewport coordinates. Null when no menu is open. */
    protected readonly menuAt = signal<{x: number; y: number} | null>(null);
    protected readonly statsOpen = signal(false);

    /** Local publish statistics for the sharer's own tile, inbound statistics for everyone else's. */
    protected readonly panelStats = computed<StreamStatsSnapshot | null>(() =>
        this.share().isLocal ? this.rustMedia.outboundStats() : this.inboundStatsOf()(this.share()),
    );

    protected openMenu(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.menuAt.set({x: event.clientX, y: event.clientY});
    }

    /** Whether an inspection is running on this tile's behalf, whoever asked for it. */
    private inspecting = false;

    /** Start the poll that feeds this tile's readout, if one is not already running. */
    private beginInspect(): void {
        if (this.inspecting) return;
        this.inspecting = true;
        if (this.share().isLocal) this.rustMedia.inspectOutbound(true);
        else this.statsInspect.emit(this.share());
    }

    /** Stop that poll. Idempotent: the panel, a copy and teardown can each be the last to want it closed. */
    private endInspect(): void {
        if (!this.inspecting) return;
        this.inspecting = false;
        if (this.share().isLocal) this.rustMedia.inspectOutbound(false);
        else this.statsInspect.emit(null);
    }

    protected openStats(): void {
        this.menuAt.set(null);
        this.statsOpen.set(true);
        this.beginInspect();
    }

    protected closeStats(): void {
        this.statsOpen.set(false);
        this.endInspect();
    }

    /** Put the current snapshot on the clipboard as JSON, starting an inspection if there is none. */
    protected async copyStats(): Promise<void> {
        this.menuAt.set(null);

        const stats = await this.snapshotToCopy();
        if (this.destroyed) return;
        if (!stats) {
            this.showCopyNotice('failed');
            return;
        }

        try {
            await navigator.clipboard?.writeText(JSON.stringify(stats, null, 2));
            this.showCopyNotice('copied');
        } catch {
            // A denied or absent clipboard.
            this.showCopyNotice('failed');
        }
    }

    /** The snapshot to copy, waiting for one if the poll has to be started first. Null after {@link COPY_WAIT_MS}. */
    private snapshotToCopy(): Promise<StreamStatsSnapshot | null> {
        const existing = this.panelStats();
        if (existing) return Promise.resolve(existing);

        this.beginInspect();
        return new Promise<StreamStatsSnapshot | null>(resolve => {
            const deadline = Date.now() + COPY_WAIT_MS;
            const timer = setInterval(() => {
                const snapshot = this.panelStats();
                if (!snapshot && !this.destroyed && Date.now() < deadline) return;
                clearInterval(timer);
                // The panel, if it is open, is still reading this poll and must keep it.
                if (!this.statsOpen()) this.endInspect();
                resolve(snapshot ?? null);
            }, COPY_POLL_MS);
        });
    }

    /** What the last copy did, shown briefly on the tile. Null while there is nothing to say. */
    protected readonly copyNotice = signal<'copied' | 'failed' | null>(null);

    protected readonly copyNoticeKey = computed(() =>
        this.copyNotice() === 'copied' ? 'CALL.STATS_NERD.COPIED' : 'CALL.STATS_NERD.COPY_FAILED',
    );

    private copyNoticeTimer?: ReturnType<typeof setTimeout>;

    private showCopyNotice(result: 'copied' | 'failed'): void {
        clearTimeout(this.copyNoticeTimer);
        this.copyNotice.set(result);
        this.copyNoticeTimer = setTimeout(() => this.copyNotice.set(null), COPY_NOTICE_MS);
    }

    protected readonly root = viewChild.required<ElementRef<HTMLElement>>('root');
    protected readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
    /** The pan/zoom surface: everything that is the picture, and nothing that is chrome. */
    protected readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');

    private readonly rustMedia = inject(RustMediaService);

    /** Set the instant teardown begins, so nothing awaiting mid-teardown writes to a dead component. */
    private destroyed = false;

    /** Whether this tile is the thing putting the local publish render on screen right now. */
    protected readonly showingLocalPreview = computed(() => {
        const s = this.share();
        return s.isLocal && !!s.localRender;
    });

    /** Paused only means anything while this tile is the one actually showing the preview. */
    protected readonly previewPaused = computed(
        () => this.showingLocalPreview() && this.rustMedia.previewPaused(),
    );

    /** Whether this share's picture is between tracks - see `CallScreenShare.state`. */
    protected readonly resuming = computed(() => this.share().state === 'resuming');

    /** The last stream this tile was given, kept so the picture can be held across a resume. */
    private readonly lastStream = signal<MediaStream | null>(null);

    /** What the `<video>` element actually plays: the current stream, or the last one while {@link resuming}. */
    protected readonly pictureStream = computed(
        () => this.share().stream ?? (this.resuming() ? (this.lastStream() ?? undefined) : undefined),
    );

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

    /** Whether the picture is currently living in a pop-out window. */
    protected readonly poppedOut = signal(false);

    /**
     * Which kind of picture-in-picture this tile can actually perform right now, or null for none.
     * Both the rendering gate and the dispatch branch must derive from this one value.
     */
    protected readonly pipRoute = computed<PipRoute | null>(() => {
        if (this.poppedOut()) return 'document';
        const s = this.share();
        if (!s.stream && !s.previewSrc) return null;
        if (documentPipApi()) return 'document';
        return videoPipSupported() && s.stream ? 'video' : null;
    });

    /** Whether to render the PiP control at all. Never true without a route the click can follow. */
    protected readonly canPip = computed(() => this.pipRoute() !== null);

    protected readonly pipLabelKey = computed(() =>
        this.pipRoute() === 'document' ? 'CALL.POP_OUT' : 'CALL.PICTURE_IN_PICTURE',
    );

    /** Pressed state for the control. Null on the video route: that overlay's state is not tracked here. */
    protected readonly pipPressed = computed(() =>
        this.pipRoute() === 'document' ? this.poppedOut() : null,
    );

    private dragging: {startX: number; startY: number; originX: number; originY: number} | null = null;

    /** Whether the last press actually moved the picture, and so was a pan rather than a click. */
    private panned = false;

    /** The window `popOut()` opened, while it is open. */
    private pipWindow: Window | null = null;

    /** Where the popped-out surface came from, held as parent plus next sibling rather than an index. */
    private restorePoint: {parent: Node; nextSibling: Node | null} | null = null;

    constructor() {
        // Remembers the picture, so pictureStream has something to hold when the track closes.
        // Only ever set from a stream that exists.
        effect(
            () => {
                const stream = this.share().stream;
                if (stream) this.lastStream.set(stream);
            },
            {allowSignalWrites: true},
        );

        // Claims "somebody is rendering the preview" for the idle pause. Every way
        // showingLocalPreview can go false must release, or the idle timer never starts.
        effect(onCleanup => {
            if (!this.showingLocalPreview()) return;
            this.rustMedia.claimPreviewRender(this);
            onCleanup(() => this.rustMedia.releasePreviewRender(this));
        });

        // `root` rather than the host element: the host is `display: contents` and measures as zero.
        trackTileHeight(
            this.root,
            this.tileScope,
            computed(() => shareTile(this.share()).id),
            computed(() => (this.share().isLocal ? null : this.share().userId)),
        );
    }

    /** The resume button on the paused card, guarded by {@link trackActivationClick} like the surface press. */
    protected resumePreview(): void {
        if (this.isActivationClick()) return;
        this.rustMedia.resumePreview();
    }

    protected zoomIn(): void {
        this.zoom.update(z => (z < MAX_ZOOM ? +(z + ZOOM_STEP).toFixed(2) : z));
    }

    protected zoomOut(): void {
        const next = Math.max(1, +(this.zoom() - ZOOM_STEP).toFixed(2));
        this.zoom.set(next);
        // Back at 1x the content fits the tile again, so any pan offset only pushes it off-centre.
        if (next === 1) this.pan.set({x: 0, y: 0});
    }

    /** Panning only means anything once the content is larger than its tile. */
    /** A press on the picture opens the stream, and a press on the open stream puts it back. */
    /** The press that brought the app back to the front is not also a command. */
    private readonly isActivationClick = trackActivationClick();

    protected openOrClose(): void {
        if (this.isActivationClick()) return;
        // The picture carries this handler into the pop-out window, so a click from over there
        // must not rearrange the stage behind it.
        if (this.poppedOut()) return;
        if (this.panned) {
            this.panned = false;
            return;
        }
        this.maximizeToggle.emit();
    }

    protected startPan(event: MouseEvent): void {
        if (this.zoom() <= 1) return;
        event.preventDefault();
        this.panned = false;
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
        this.panned = true;
        this.pan.set({
            x: drag.originX + (event.clientX - drag.startX),
            y: drag.originY + (event.clientY - drag.startY),
        });
    }

    protected endPan(): void {
        this.dragging = null;
    }

    /** Fullscreens the tile rather than the `<video>`, so the name pill, LIVE badge and viewer count go with it. */
    protected toggleFullscreen(): void {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => void 0);
        else
            void this.root()
                .nativeElement.requestFullscreen()
                .catch(() => void 0);
    }

    /**
     * The one PiP control, dispatched down whichever route `pipRoute()` said the button was for.
     * Never add a capability check here that `pipRoute()` does not also make.
     */
    protected togglePip(): void {
        switch (this.pipRoute()) {
            case 'document':
                void this.popOut();
                break;
            case 'video':
                this.toggleVideoPip();
                break;
        }
    }

    /**
     * Lifts the pan/zoom surface into its own OS window. The element is moved, not recreated, so the
     * live `MediaStream` travels with it; the overlays stay behind or the tile's grid slot collapses.
     */
    private async popOut(): Promise<void> {
        // Second press on an open pop-out closes it. The window's own pagehide restores the element,
        // so there is exactly one restore path.
        if (this.pipWindow) {
            this.pipWindow.close();
            return;
        }

        const api = documentPipApi();
        const surface = this.surface().nativeElement;
        // The parent is what the restore anchors on; without one the pop-out cannot be undone.
        if (!api || !surface.parentNode) return;

        const box = surface.getBoundingClientRect();
        let pip: Window;
        try {
            pip = await api.requestWindow({
                width: Math.round(box.width) || POP_OUT_FALLBACK.width,
                height: Math.round(box.height) || POP_OUT_FALLBACK.height,
            });
        } catch {
            // Denied, or unimplemented behind a present-looking API. Nothing has moved yet.
            return;
        }

        this.adoptStyles(pip);
        this.restorePoint = {parent: surface.parentNode, nextSibling: surface.nextSibling};
        pip.document.body.append(surface);

        this.pipWindow = pip;
        this.poppedOut.set(true);
        pip.addEventListener('pagehide', () => this.restoreFromPopOut(), {once: true});
    }

    /** Gives the pop-out document the page's own styles, so the moved subtree is not unstyled. */
    private adoptStyles(pip: Window): void {
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                const css = Array.from(sheet.cssRules)
                    .map(rule => rule.cssText)
                    .join('\n');
                const style = pip.document.createElement('style');
                style.textContent = css;
                pip.document.head.append(style);
            } catch {
                if (!sheet.href) continue;
                const link = pip.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = sheet.href;
                pip.document.head.append(link);
            }
        }

        // The dark tokens are keyed off a class on `body` (see index.html).
        pip.document.body.className = document.body.className;
        pip.document.body.style.margin = '0';
        pip.document.body.style.background = 'var(--color-stage)';
    }

    /** Puts the picture back exactly where it was, and is safe to call when it never left. */
    private restoreFromPopOut(): void {
        const point = this.restorePoint;
        this.restorePoint = null;
        this.pipWindow = null;
        this.poppedOut.set(false);
        if (!point) return;

        const surface = this.surface().nativeElement;
        const anchor =
            point.nextSibling?.parentNode === point.parent ? point.nextSibling : point.parent.firstChild;
        point.parent.insertBefore(surface, anchor);
    }

    /**
     * Restore the popped-out surface before closing its window, and end any inspection: the services
     * holding the other end are root-provided, so a poll left running outlives the whole call.
     */
    ngOnDestroy(): void {
        this.destroyed = true;
        clearTimeout(this.copyNoticeTimer);
        this.statsOpen.set(false);
        this.endInspect();

        const pip = this.pipWindow;
        this.restoreFromPopOut();
        pip?.close();
    }

    /** The fallback route: the browser's own always-on-top overlay for a single `<video>`. */
    private toggleVideoPip(): void {
        const video = this.video()?.nativeElement;
        if (!video || !videoPipSupported()) return;
        if (document.pictureInPictureElement === video)
            void document.exitPictureInPicture().catch(() => void 0);
        else void video.requestPictureInPicture().catch(() => void 0);
    }
}
