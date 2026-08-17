import {ResizeDirection, WindowChrome} from '../ports/window-chrome.port';

/**
 * The real window frame, via `@tauri-apps/api/window`.
 *
 * <p>`getCurrentWindow()` itself is cheap, but the module it lives in is not something the web bundle
 * should ever fetch - so it is behind an `import()` resolved on first use and then held. Held rather
 * than re-imported per call only to keep the promise chain short; the module registry would dedupe it
 * anyway.</p>
 */
export class TauriWindowChrome extends WindowChrome {
    readonly supported = true;

    private window?: Promise<Awaited<ReturnType<typeof currentWindow>>>;

    /**
     * Maximised or fullscreen, folded into one answer.
     *
     * <p>Both are read, not just `isMaximized`: a window taken fullscreen is not maximised by Tauri's
     * reckoning, and the app's rounded corners have to come off for either - see
     * `WindowChromeService`, which is the reason this question is asked at all.</p>
     */
    async isFlush(): Promise<boolean> {
        const win = await this.current();
        const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
        return maximized || fullscreen;
    }

    async onResized(handler: () => void): Promise<() => void> {
        const win = await this.current();
        return win.onResized(() => handler());
    }

    /**
     * <p><b>The handler is wrapped so it cannot reject.</b> Tauri calls `prevent_close()` for any
     * window carrying a JS `tauri://close-requested` listener and leaves the JS wrapper to finish with
     * `destroy()` once the handler resolves - so a throw here does not merely lose whatever the
     * handler was doing, it leaves a window the user cannot shut. That was a real release: see the
     * `core:window:allow-destroy` note in `titlebar.component.spec.ts`.</p>
     */
    async onCloseRequested(handler: () => void): Promise<() => void> {
        const win = await this.current();
        return win.onCloseRequested(() => {
            try {
                handler();
            } catch (err) {
                console.error('[WindowChrome] a close handler threw; closing anyway', err);
            }
        });
    }

    async minimize(): Promise<void> {
        return (await this.current()).minimize();
    }

    async toggleMaximize(): Promise<void> {
        return (await this.current()).toggleMaximize();
    }

    async isMaximized(): Promise<boolean> {
        return (await this.current()).isMaximized();
    }

    async close(): Promise<void> {
        return (await this.current()).close();
    }

    async startDragging(): Promise<void> {
        return (await this.current()).startDragging();
    }

    async startResizeDragging(direction: ResizeDirection): Promise<void> {
        return (await this.current()).startResizeDragging(direction);
    }

    private current(): Promise<Awaited<ReturnType<typeof currentWindow>>> {
        return (this.window ??= currentWindow());
    }
}

/** Separate so its return type can be named above without restating Tauri's `Window`. */
async function currentWindow() {
    const {getCurrentWindow} = await import('@tauri-apps/api/window');
    return getCurrentWindow();
}
