import {ResizeDirection, WindowChrome} from '../ports/window-chrome.port';

/**
 * A {@link WindowChrome} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/api/window')` blocks the titlebar and presence specs used to
 * hoist. The gain over those is the two triggers below: {@link resize} and {@link requestClose} let a
 * test fire the events the real window fires, which a module mock returning `{onResized: vi.fn()}` could
 * not - `titlebar.component.spec.ts` had no way to exercise its own maximise tracking, and the presence
 * teardown-on-close path had no way to run at all.</p>
 *
 * <p>{@link supported} is a plain mutable field rather than a `readonly` override so one spec can cover
 * both hosts. Set it to false and the callers under test should never touch anything else here - which
 * is what {@link calls} is for.</p>
 */
export class FakeWindowChrome extends WindowChrome {
    supported = true;

    /** Every call, as `[method, ...args]`. Assert on this to prove a control was properly gated. */
    readonly calls: unknown[][] = [];

    /** What {@link isFlush} answers - maximised or fullscreen, folded into one. */
    flush = false;

    /** What {@link isMaximized} answers. */
    maximized = false;

    private resizeHandler: (() => void) | null = null;
    private closeHandler: (() => void) | null = null;

    async isFlush(): Promise<boolean> {
        this.calls.push(['isFlush']);
        return this.flush;
    }

    async onResized(handler: () => void): Promise<() => void> {
        this.calls.push(['onResized']);
        this.resizeHandler = handler;
        return () => {
            this.resizeHandler = null;
        };
    }

    async onCloseRequested(handler: () => void): Promise<() => void> {
        this.calls.push(['onCloseRequested']);
        this.closeHandler = handler;
        return () => {
            this.closeHandler = null;
        };
    }

    async minimize(): Promise<void> {
        this.calls.push(['minimize']);
    }

    async toggleMaximize(): Promise<void> {
        this.calls.push(['toggleMaximize']);
    }

    async isMaximized(): Promise<boolean> {
        this.calls.push(['isMaximized']);
        return this.maximized;
    }

    async close(): Promise<void> {
        this.calls.push(['close']);
    }

    async startDragging(): Promise<void> {
        this.calls.push(['startDragging']);
    }

    async startResizeDragging(direction: ResizeDirection): Promise<void> {
        this.calls.push(['startResizeDragging', direction]);
    }

    /** Fires the resize event, which covers maximize, restore and fullscreen alike. */
    resize(): void {
        this.resizeHandler?.();
    }

    /**
     * Fires `close-requested`, the way the titlebar's close button does once anything has subscribed.
     *
     * <p>Does not swallow a throw, deliberately: the Tauri adapter is what guarantees a handler cannot
     * reject, and a fake that also swallowed would hide a subscriber that throws.</p>
     */
    requestClose(): void {
        this.closeHandler?.();
    }

    /** Whether anything has taken ownership of the window's close. */
    get hasCloseHandler(): boolean {
        return this.closeHandler !== null;
    }

    /** Every call to `method`, as its argument list. */
    callsTo(method: string): unknown[][] {
        return this.calls.filter(call => call[0] === method).map(call => call.slice(1));
    }
}
