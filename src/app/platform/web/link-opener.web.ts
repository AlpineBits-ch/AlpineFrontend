import {LinkOpener} from '../ports/link-opener.port';

/**
 * Schemes a link from message content is allowed to reach.
 *
 * <p>Everything else is refused. `javascript:` is the reason this list exists: the URLs handed to this
 * adapter include hrefs lifted out of message markdown and fields of server-generated embed cards, so
 * they are attacker-influenced by definition, and `window.open('javascript:...')` runs script rather
 * than navigating. The markdown pipe already runs DOMPurify over the HTML, which strips such hrefs -
 * this is the second lock on the same door, placed where the actual navigation happens.</p>
 *
 * <p>Trailing colons because that is how {@link URL.protocol} reports them.</p>
 */
const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Opens the URL in a new browser tab.
 *
 * <p><b>`noopener` is not optional here.</b> Without it the opened page gets a live `window.opener`
 * handle back into this document's window and can navigate it - the standard reverse-tabnabbing trick,
 * pointing the app's own tab at a copy of the login screen. `noreferrer` goes with it so a link out of
 * a private conversation does not leak which page it came from.</p>
 */
export class WebLinkOpener extends LinkOpener {
    override async open(url: string): Promise<void> {
        if (!isOpenable(url)) {
            // Refused rather than thrown: every call site does `void open(url)` on a click, so a
            // rejection here becomes an unhandled promise rejection and, in production, a Sentry
            // report about a link the app was right to ignore.
            console.warn('Refusing to open a URL with a scheme that is not web-openable:', url);
            return;
        }

        // The return value is deliberately not inspected. A spec-compliant `window.open` returns null
        // whenever `noopener` is set, so null cannot be told apart from a blocked popup and testing it
        // would report every successful open as a failure. Popup blockers allow this anyway: every
        // caller runs inside a click handler, which is the user gesture they look for.
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

/**
 * Whether this is a URL a browser tab can be pointed at.
 *
 * <p>Relative and malformed URLs are refused along with the dangerous ones. `URL` needs a base to
 * resolve a relative reference, and this port's job is leaving the app - a caller wanting to navigate
 * inside it wants the router.</p>
 *
 * <p>This is stricter than the desktop adapter, which hands the string to the OS unexamined. That
 * asymmetry is on purpose: on desktop a stray scheme launches some other application, which is
 * governed by the shell's own opener permissions, while in a browser it can execute in this origin.</p>
 */
function isOpenable(url: string): boolean {
    try {
        return ALLOWED_SCHEMES.includes(new URL(url).protocol);
    } catch {
        return false;
    }
}
