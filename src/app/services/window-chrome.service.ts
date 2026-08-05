import {Injectable, signal} from '@angular/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import type {UnlistenFn} from '@tauri-apps/api/event';

/**
 * Owns the two things that follow from `decorations: false, transparent: true`: the window's own
 * rounded corners, and the fact that nothing but the titlebar can move it.
 *
 * <p>Both are invisible until they are not. The app draws its own frame, so the radius is ours to
 * turn off when the window is flush against the screen edges - left on, it renders the desktop
 * through four notches at the corners of a maximized window. And a modal mask covers the titlebar
 * along with everything else, so opening any dialog silently took away the user's ability to move
 * the window at all.</p>
 */
@Injectable({providedIn: 'root'})
export class WindowChromeService {
    /**
     * Matches `.titlebar`'s height in titlebar.component.css. The two have to agree: this is the
     * strip in which a press on an overlay is read as "move the window" rather than as a click.
     */
    private static readonly TITLEBAR_HEIGHT = 38;

    /** True whenever the window sits flush to the screen edges, by either route. */
    readonly isFlush = signal(false);

    private unlistenResize?: UnlistenFn;
    private started = false;

    async start(): Promise<void> {
        if (this.started) return;
        if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
        this.started = true;

        // Capture phase, because an overlay mask will happily stop this from bubbling - and a mask
        // that swallows the press is the entire problem being solved here.
        document.addEventListener('mousedown', this.onMouseDown, true);

        const win = getCurrentWindow();
        await this.refreshFlush();
        // Maximize, restore and fullscreen all resize the window, so one listener covers all three.
        this.unlistenResize = await win.onResized(() => void this.refreshFlush());
    }

    stop(): void {
        document.removeEventListener('mousedown', this.onMouseDown, true);
        this.unlistenResize?.();
        this.unlistenResize = undefined;
        this.started = false;
    }

    private async refreshFlush(): Promise<void> {
        const win = getCurrentWindow();
        try {
            const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
            const flush = maximized || fullscreen;
            this.isFlush.set(flush);
            // On the root element rather than a component host: the radius belongs to `app-root`,
            // which is styled globally and has no component of its own to bind a class on.
            document.documentElement.toggleAttribute('data-window-flush', flush);
        } catch (err) {
            console.error('Could not read the window state', err);
        }
    }

    /**
     * Lets the titlebar strip move the window even when something is painted over it.
     *
     * <p>Tauri's own `data-tauri-drag-region` is resolved from the event target, so it stops working
     * the moment anything covers the titlebar - which is every modal, since a mask spans the whole
     * window. Presses that land on a real drag region are left alone and handled natively; this
     * only picks up the ones that would otherwise be swallowed.</p>
     */
    private readonly onMouseDown = (event: MouseEvent): void => {
        if (event.button !== 0) return;
        if (event.clientY >= WindowChromeService.TITLEBAR_HEIGHT) return;

        const target = event.target as Element | null;
        if (!target) return;
        // Already draggable: Tauri will handle it, and calling startDragging as well drops the
        // double-click-to-maximize gesture that the native path gives us for free.
        if (target.closest('[data-tauri-drag-region]')) return;
        if (!this.isOverlaySurface(target)) return;

        event.preventDefault();
        void getCurrentWindow().startDragging().catch(err =>
            console.error('Could not start dragging the window', err));
    };

    /**
     * Whether this press landed on an overlay's own backdrop rather than on its contents.
     *
     * <p>Deliberately narrow. Anything inside a dialog that happens to sit in the top 32 pixels -
     * a close button, a header, a text field - has to keep behaving like itself, so only the
     * backdrop elements themselves qualify.</p>
     */
    private isOverlaySurface(target: Element): boolean {
        return target.matches('.p-dialog-mask, .p-overlay-mask, [data-window-drag-surface]');
    }
}
