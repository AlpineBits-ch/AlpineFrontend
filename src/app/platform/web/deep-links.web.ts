import {DeepLinks} from '../ports/deep-links.port';

/**
 * There are no out-of-band deep links in a browser tab.
 *
 * <p>Not a stub that "should" do something later: the address bar <i>is</i> the launch URL, so a link
 * someone follows to this app arrives as a navigation the router handles, with the whole URL available
 * synchronously from `location`. Reporting it here as a launch URL as well would hand the same link to
 * two consumers.</p>
 */
export class WebDeepLinks extends DeepLinks {
    /**
     * Always null.
     *
     * <p><b>And so this adapter needs no consumed-once guard, which is the point worth recording.</b>
     * The desktop plugin's `getCurrent()` keeps returning the same launch URL for the life of the OS
     * process, so a reload replays it and reopens whatever dialog it triggered; the Tauri adapter
     * carries a `sessionStorage` flag to spend it exactly once. Returning a URL here - say,
     * `location.href` - would recreate that hazard in its worst form, because a browser reload is
     * ordinary and a route the user simply stayed on would be re-handled as a fresh arrival on every
     * refresh. A deep link that lands in the address bar is already handled, by routing.</p>
     */
    override async initial(): Promise<string | null> {
        return null;
    }

    /**
     * Never fires; resolves a no-op teardown.
     *
     * <p>The unsubscribe is real so callers need no null check. `handler` is intentionally unused: a
     * second navigation to this origin either reuses this document, which is a router event, or opens a
     * new tab, which boots its own copy of the app.</p>
     */
    override async onOpen(handler: (urls: string[]) => void): Promise<() => void> {
        void handler;
        return () => {
            // Nothing was subscribed.
        };
    }
}
