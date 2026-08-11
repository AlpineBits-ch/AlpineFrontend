import {DeepLinks} from '../ports/deep-links.port';

/**
 * Survives a reload, but not a relaunch - which is exactly the lifetime a "was this process launched
 * by a link" answer needs. Kept at the string the app already used so an update mid-session does not
 * replay a link the previous build had consumed.
 */
const CONSUMED_KEY = 'alpine.coldStartDeepLinkConsumed';

/**
 * `venta://` links delivered by the OS.
 *
 * <p>The plugin is {@code import()}ed inside each method. `app.component.ts` used to import it
 * statically, which evaluated the module during bootstrap and killed a browser boot before anything
 * rendered - that failure is the reason this port exists.</p>
 */
export class TauriDeepLinks extends DeepLinks {
    /**
     * Set the moment {@link initial} is entered, before anything is awaited.
     *
     * <p>Two callers racing would otherwise both see an unconsumed flag and both handle the URL, opening
     * the invite dialog twice. It also carries the guard on its own where `sessionStorage` throws (some
     * private-browsing modes), degrading it from once-per-process to once-per-adapter.</p>
     *
     * <p>Instance state rather than module state on purpose: `providePlatform()` builds exactly one of
     * these per injector, so an instance flag <i>is</i> a per-document flag - and it is state a test can
     * reach by constructing a new adapter, instead of one that needs the module re-evaluated.</p>
     */
    private consumed = false;

    /**
     * The launch URL, exactly once per OS process.
     *
     * <p><b>The once-per-process guard lives here rather than at the call site.</b>
     * `getCurrent()` keeps returning the same URL for the whole life of the process, so a plain
     * reload (Ctrl+F5) re-runs the caller and reopens whatever dialog the link asked for - every
     * time. That is a property of this plugin, so the port promises "once" and this adapter is what
     * has to keep the promise. The web adapter has nothing to guard, because it has no launch URL to
     * repeat.</p>
     *
     * <p>Returns the first URL when the plugin reports several. An OS launch carries one link; the
     * array is the plugin's shape, not a queue. Links that arrive while the app is running come
     * through {@link onOpen}, which keeps the whole list.</p>
     *
     * <p>TODO: drop the guard if Tauri ever grows a "deep link consumed" signal of its own.</p>
     */
    override async initial(): Promise<string | null> {
        if (this.consumed || readConsumedFlag()) return null;
        this.consumed = true;
        writeConsumedFlag();

        const {getCurrent} = await import('@tauri-apps/plugin-deep-link');
        const urls = await getCurrent();
        return urls?.[0] ?? null;
    }

    override async onOpen(handler: (urls: string[]) => void): Promise<() => void> {
        const {onOpenUrl} = await import('@tauri-apps/plugin-deep-link');
        return onOpenUrl(handler);
    }
}

function readConsumedFlag(): boolean {
    try {
        return sessionStorage.getItem(CONSUMED_KEY) !== null;
    } catch {
        // No session storage: the adapter's own flag is the whole guard. A launch link is then handled
        // once per document rather than once per process, which repeats it on a manual reload -
        // strictly better than dropping a cold-start link that has not been handled at all.
        return false;
    }
}

function writeConsumedFlag(): void {
    try {
        sessionStorage.setItem(CONSUMED_KEY, '1');
    } catch {
        // Ignored for the reason above.
    }
}
