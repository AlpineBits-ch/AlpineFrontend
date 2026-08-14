import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    input,
    OnDestroy,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenShare} from '../call.types';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {CallLiveBadgeComponent} from '../call-live-badge/call-live-badge.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';
import {documentPipApi, videoPipSupported} from '../pip-support';

const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

/** Fallback pop-out size, used when the tile has no measurable box yet. 16:9, the shape of a share. */
const POP_OUT_FALLBACK = {width: 960, height: 540};

/** Which kind of picture-in-picture this tile can actually perform, if any. */
type PipRoute = 'document' | 'video';

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
export class CallShareTileComponent implements OnDestroy {
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
    /**
     * The pan/zoom surface: everything that is the picture, and nothing that is chrome. This is the
     * element the pop-out moves - see `popOut()` for why the tile's overlays stay behind.
     */
    protected readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');

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
     *
     * <p>This is the capability gate and the dispatch table in one value, deliberately, and the
     * invariant runs in both directions: the control is never rendered without a route the press
     * can follow, <em>and</em> the route is never withdrawn while the press is still in effect.</p>
     *
     * <p>The first direction is what the original gate got wrong. It answered "is any PiP API
     * present" while the action could only ever do video PiP, so on a host with document PiP and no
     * video PiP - the exact WebView2 skew this feature lives under - the button rendered and the
     * click did nothing. Deriving both the rendering and the branch taken from this one value makes
     * that impossible rather than merely discouraged.</p>
     *
     * <p>The second direction is the same fault reversed, and is why `poppedOut()` is consulted
     * first. A share can lose its stream and its preview while its picture is sitting in an open
     * pop-out window; without this line the route would go null, the `@if` would drop the button,
     * and the user would be left with a picture in a window the app no longer offers any way to
     * close and an empty tile behind it. While a pop-out is open, the route stays the one that
     * opened it, because closing it is still something the press can do.</p>
     *
     * <p>Document PiP wins when both are available. It carries the whole picture surface, including
     * the local share's `<img>` preview - the Rust-published desktop path puts no `MediaStream` in
     * the webview at all (see `CallScreenShare.previewSrc`), so video PiP has nothing to pop there.
     * Video PiP is the fallback for a real stream on a host without document PiP.</p>
     *
     * <p>Both routes need something to look at. A share with neither a stream nor a preview renders
     * only the "waiting for the picture" placeholder, and popping an empty box out into its own OS
     * window is a button that technically fires and visibly accomplishes nothing.</p>
     *
     * <p>Read lazily through pip-support.ts rather than cached at module load, so a capability the
     * webview only grants later - or a test stub - is picked up on the next read.</p>
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

    /**
     * "Pop out" is an OS window you can drag onto another monitor; "picture in picture" is the
     * browser's small always-on-top video overlay. They are different enough that calling both by
     * the same name would mislead whichever host got the other one.
     */
    protected readonly pipLabelKey = computed(() =>
        this.pipRoute() === 'document' ? 'CALL.POP_OUT' : 'CALL.PICTURE_IN_PICTURE');

    /**
     * Pressed state for the control, so a tile whose picture has left is not just an unexplained
     * black box. Null on the video route: that overlay's state is not tracked here. The platform
     * does report it - `document.pictureInPictureElement` and the enter/leave events - but nothing
     * in this component subscribes, so announcing `aria-pressed` would be announcing a value that
     * only ever changes when this tile happens to be the thing that opened the overlay.
     */
    protected readonly pipPressed = computed(() =>
        this.pipRoute() === 'document' ? this.poppedOut() : null);

    private dragging: {startX: number; startY: number; originX: number; originY: number} | null = null;

    /** The window `popOut()` opened, while it is open. */
    private pipWindow: Window | null = null;

    /**
     * Where the popped-out surface came from. Held as parent plus next sibling rather than an index,
     * because the tile's overlays stay in that parent and keep rendering while the picture is away:
     * an index would be a bet that none of them appeared or disappeared in the meantime, and the
     * hover clusters, the viewer popover and the fps readouts all come and go on their own.
     */
    private restorePoint: {parent: Node; nextSibling: Node | null} | null = null;

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

    /**
     * The one PiP control, dispatched down whichever route `pipRoute()` said the button was for.
     * Never add a capability check here that `pipRoute()` does not also make - that split is what
     * produced a button that rendered and did nothing.
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
     * Lifts the picture into its own OS window, which can be dragged off the app, resized and left
     * on top of other applications.
     *
     * <p>The element is <em>moved</em>, not recreated. A second window rendering its own `<video>`
     * would need its own peer connection and its own signalling client - video is received in the
     * webview by design - whereas moving the live element carries the `MediaStream` with it,
     * uninterrupted, with nothing re-subscribed. That is the whole reason this is Document PiP and
     * not a second Tauri window.</p>
     *
     * <p>What travels is the pan/zoom surface: the picture and the drag handling that goes with it.
     * What stays is every overlay - LIVE badge, viewer count and its popover, name pill, fps
     * readouts, the hover clusters. Two reasons. They are positioned against the tile root, so they
     * would have to take the root with them, and the root leaving the layout would collapse the
     * tile's slot in the grid. And this control is itself in one of those clusters: send it to the
     * pop-out and the app window is left with no way to bring the picture back.</p>
     */
    private async popOut(): Promise<void> {
        // Second press on an open pop-out closes it. The window's own pagehide is what restores the
        // element, so there is exactly one restore path whether the user pressed this or the OS
        // close button.
        if (this.pipWindow) {
            this.pipWindow.close();
            return;
        }

        const api = documentPipApi();
        const surface = this.surface().nativeElement;
        // The parent is what the restore anchors on; without one there is nowhere to put the
        // picture back, and a pop-out that cannot be undone is worse than none.
        if (!api || !surface.parentNode) return;

        const box = surface.getBoundingClientRect();
        let pip: Window;
        try {
            pip = await api.requestWindow({
                width: Math.round(box.width) || POP_OUT_FALLBACK.width,
                height: Math.round(box.height) || POP_OUT_FALLBACK.height,
            });
        } catch {
            // Denied, or unimplemented behind a present-looking API. Nothing has moved yet, so
            // there is nothing to undo and the tile is exactly as it was.
            return;
        }

        this.adoptStyles(pip);
        this.restorePoint = {parent: surface.parentNode, nextSibling: surface.nextSibling};
        pip.document.body.append(surface);

        this.pipWindow = pip;
        this.poppedOut.set(true);
        pip.addEventListener('pagehide', () => this.restoreFromPopOut(), {once: true});
    }

    /**
     * Gives the pop-out document the page's own styles, so the moved subtree is not unstyled the
     * instant it lands: every class on it - the layout, the object-contain sizing, the transition -
     * is defined in a stylesheet the new document does not have.
     *
     * <p>Rules are read and re-inlined rather than the `<style>` nodes being cloned, because in a
     * production build the styles arrive as a `<link>` whose element carries no rules to clone. A
     * stylesheet that refuses to expose its rules is cross-origin; those can only be re-linked.</p>
     */
    private adoptStyles(pip: Window): void {
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                const css = Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n');
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

        // The dark tokens are keyed off a class on <body> (see index.html), and the surface fills a
        // body that would otherwise be white paper with an 8px margin around the picture.
        pip.document.body.className = document.body.className;
        pip.document.body.style.margin = '0';
        pip.document.body.style.background = 'var(--color-stage)';
    }

    /**
     * Puts the picture back exactly where it was, and is safe to call when it never left.
     *
     * <p>The saved next sibling is only usable if it is still a child of the saved parent; the
     * overlays around the surface are conditional, so the one that followed it may have been
     * removed while the picture was away. Falling back to appending would put the picture last,
     * which is a stacking-order change, so re-anchor on the parent's first child instead - the
     * surface's actual place in this template.</p>
     */
    private restoreFromPopOut(): void {
        const point = this.restorePoint;
        this.restorePoint = null;
        this.pipWindow = null;
        this.poppedOut.set(false);
        if (!point) return;

        const surface = this.surface().nativeElement;
        const anchor = point.nextSibling?.parentNode === point.parent
            ? point.nextSibling
            : point.parent.firstChild;
        point.parent.insertBefore(surface, anchor);
    }

    /**
     * Closing the call while the picture is popped out must not leave the element stranded in a
     * window Angular no longer knows about. Restoring first and closing second is deliberate: it
     * means the surface is back inside the view being torn down, so the renderer and the
     * `streamSrc` directive clean it up the way they would have anyway, and the pagehide handler
     * that the `close()` then fires finds the state already cleared and does nothing.
     */
    ngOnDestroy(): void {
        const pip = this.pipWindow;
        this.restoreFromPopOut();
        pip?.close();
    }

    /** The fallback route: the browser's own always-on-top overlay for a single `<video>`. */
    private toggleVideoPip(): void {
        const video = this.video()?.nativeElement;
        if (!video || !videoPipSupported()) return;
        if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => void 0);
        else void video.requestPictureInPicture().catch(() => void 0);
    }
}
