import {DeepLinks} from '../ports/deep-links.port';

/**
 * A {@link DeepLinks} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/plugin-deep-link')` block `app.component`'s spec had to hoist -
 * which was not optional there, because that plugin is imported *statically* and its module evaluation
 * is what killed a browser boot in the first place.</p>
 *
 * <p>Defaults to <b>no launch URL and nothing delivered</b>: the app was started normally. That is the
 * inert default the collateral specs need, and the two things worth testing are one line each -
 * {@link initial} answering a URL, and {@link deliver} firing one mid-session.</p>
 *
 * <p>{@link initialCalls} matters more than it looks: the desktop plugin keeps returning the same launch
 * URL for the life of the process, so a caller that reads it twice reopens whatever dialog it triggered.
 * Counting the reads is how a spec pins that it is spent exactly once.</p>
 */
export class FakeDeepLinks extends DeepLinks {
    /** What {@link initial} answers. Null is the browser, and a normally-launched desktop app. */
    launchUrl: string | null = null;

    /** How many times the launch URL was read. */
    initialCalls = 0;

    /** Set to make {@link initial} reject - an IPC round trip that failed. */
    initialError: Error | null = null;

    /** Set to make {@link onOpen} reject, standing in for a host that delivers no links. */
    subscribeError: Error | null = null;

    private readonly handlers = new Set<(urls: string[]) => void>();

    async initial(): Promise<string | null> {
        this.initialCalls++;
        if (this.initialError) throw this.initialError;
        return this.launchUrl;
    }

    async onOpen(handler: (urls: string[]) => void): Promise<() => void> {
        if (this.subscribeError) throw this.subscribeError;
        this.handlers.add(handler);
        return () => void this.handlers.delete(handler);
    }

    /**
     * Delivers links to every subscriber, the way a second `venta://` activation does.
     *
     * <p>Throws when nothing has subscribed rather than passing quietly: a spec that asserts on the
     * effect of a link nobody was listening for would otherwise pass while proving nothing.</p>
     */
    deliver(...urls: string[]): void {
        if (this.handlers.size === 0) throw new Error('nothing has subscribed to deep links');
        for (const handler of [...this.handlers]) handler(urls);
    }

    /** Whether anything is still listening - a teardown that ran leaves this at zero. */
    get handlerCount(): number {
        return this.handlers.size;
    }
}
