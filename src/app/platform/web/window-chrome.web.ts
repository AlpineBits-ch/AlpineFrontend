import {ResizeDirection, WindowChrome} from '../ports/window-chrome.port';

/**
 * A browser tab has no frame to own.
 *
 * <p><b>The reads answer, the writes reject.</b> That split is the whole design of this file, and it
 * is not arbitrary:</p>
 * <ul>
 *   <li>{@link isFlush} and {@link isMaximized} are questions with a true answer on web - a tab is
 *       neither maximised nor flush against anything - so answering false is honest, not a stub.</li>
 *   <li>{@link minimize}, {@link close} and friends are <i>actions</i>. A resolved promise from one of
 *       them says "done", and the caller has no way to tell that apart from having actually minimised
 *       a window. `supported = false` means callers hide these controls entirely (the design spec's
 *       "hidden when its absence needs no explanation"), so reaching one of these is a bug in the
 *       caller - and it should read like one rather than being swallowed.</li>
 * </ul>
 */
export class WebWindowChrome extends WindowChrome {
    readonly supported = false;

    isFlush(): Promise<boolean> {
        return Promise.resolve(false);
    }

    /**
     * A resize subscription that never fires, and resolves anyway.
     *
     * <p>Deliberately not `window.onresize`: the callers of this are asking "did the window change
     * between maximised and restored", and a tab being dragged wider is not that. Registering for
     * something nobody emits is explicitly allowed by the port contract, and the unsubscribe still has
     * to be real so teardown does not have to special-case the host.</p>
     */
    onResized(_handler: () => void): Promise<() => void> {
        return Promise.resolve(() => undefined);
    }

    /**
     * Never fires either, and that is the honest answer rather than a shortfall.
     *
     * <p>The one candidate is `beforeunload`, which cannot be used for this: it may only run
     * synchronous work, the async teardown these handlers do would be cut off mid-flight, and
     * registering it costs the user a "leave site?" prompt in some browsers. A subscription that
     * never fires is better than one that fires and cannot finish - and unlike Tauri, nothing here
     * has taken ownership of the close, so nothing is left in a stuck state by not firing.</p>
     */
    onCloseRequested(_handler: () => void): Promise<() => void> {
        return Promise.resolve(() => undefined);
    }

    minimize(): Promise<void> {
        return unsupported('minimize');
    }

    toggleMaximize(): Promise<void> {
        return unsupported('toggleMaximize');
    }

    isMaximized(): Promise<boolean> {
        return Promise.resolve(false);
    }

    /**
     * <p>`window.close()` is not a substitute: it is ignored for any tab the script did not itself
     * open, which is every tab a user navigated to.</p>
     */
    close(): Promise<void> {
        return unsupported('close');
    }

    startDragging(): Promise<void> {
        return unsupported('startDragging');
    }

    startResizeDragging(_direction: ResizeDirection): Promise<void> {
        return unsupported('startResizeDragging');
    }
}

/** Named so an unhandled rejection in a console names the control that should have been hidden. */
function unsupported(operation: string): Promise<never> {
    return Promise.reject(
        new Error(
            `WindowChrome.${operation}() is desktop-only; this host has no window frame. ` +
                'Gate the control on WindowChrome.supported or PlatformCapabilities.customWindowChrome.',
        ),
    );
}
