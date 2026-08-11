/**
 * The browser link adapter.
 *
 * <p>Both assertions here are security properties rather than conveniences, which is why they are
 * pinned: the URLs reaching this adapter include hrefs out of message markdown and fields of embed
 * cards the server generated from a fetched page, so they are attacker-influenced. Dropping `noopener`
 * hands the opened page a live handle on the app's own window; letting a `javascript:` URL through runs
 * script in this origin.</p>
 */

import {WebLinkOpener} from './link-opener.web';

function watch() {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return {open, warn};
}

afterEach(() => vi.restoreAllMocks());

describe('WebLinkOpener', () => {
    it('opens a new tab with noopener and noreferrer', async () => {
        const {open} = watch();

        await new WebLinkOpener().open('https://venta.gg/help');

        expect(open).toHaveBeenCalledWith('https://venta.gg/help', '_blank', 'noopener,noreferrer');
    });

    it('opens the schemes a browser tab can be pointed at', async () => {
        const {open} = watch();
        const opener = new WebLinkOpener();

        await opener.open('http://example.com');
        await opener.open('https://example.com');
        await opener.open('mailto:someone@example.com');
        await opener.open('tel:+41000000000');

        expect(open).toHaveBeenCalledTimes(4);
    });

    /**
     * `window.open('javascript:...')` executes rather than navigating. DOMPurify already strips such
     * hrefs out of rendered markdown; this is the second lock, at the point the navigation happens.
     */
    it('refuses a javascript: URL', async () => {
        const {open, warn} = watch();

        await new WebLinkOpener().open('javascript:alert(document.cookie)');

        expect(open).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
    });

    it('refuses other non-web schemes, and malformed or relative URLs', async () => {
        const {open} = watch();
        const opener = new WebLinkOpener();

        await opener.open('data:text/html,<script>alert(1)</script>');
        await opener.open('file:///C:/Windows/System32/calc.exe');
        await opener.open('vbscript:msgbox(1)');
        await opener.open('/overview/channels/1');
        await opener.open('not a url at all');
        await opener.open('');

        expect(open).not.toHaveBeenCalled();
    });

    /**
     * A refusal resolves rather than rejecting. Every call site is `void open(url)` inside a click
     * handler, so a rejection would become an unhandled promise rejection - and in production a Sentry
     * report - about a link the app was right to ignore.
     */
    it('resolves rather than rejecting when it refuses', async () => {
        watch();

        await expect(new WebLinkOpener().open('javascript:void 0')).resolves.toBeUndefined();
    });

    /**
     * `window.open` returns null whenever `noopener` is set, so a null return cannot be told apart from
     * a blocked popup. Reading it would report every successful open as a failure.
     */
    it('does not treat the null return from a noopener open as a failure', async () => {
        const {open} = watch();
        open.mockReturnValue(null);

        await expect(new WebLinkOpener().open('https://venta.gg')).resolves.toBeUndefined();
    });
});
