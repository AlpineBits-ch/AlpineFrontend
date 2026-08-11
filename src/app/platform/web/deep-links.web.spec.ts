/**
 * The browser deep-link adapter, which is deliberately inert.
 *
 * <p>Short, but not pointless: the tempting "improvement" here is to return `location.href` from
 * {@link WebDeepLinks.initial} so that web gets deep links too. That would recreate, in a worse form,
 * exactly the hazard the desktop adapter has to guard against - the launch URL coming back forever. In a
 * browser the address bar keeps its URL for as long as the user stays on the page, so every reload would
 * re-handle it and reopen the dialog. Links that arrive in the address bar are already handled, by the
 * router. This spec is here to make that a decision rather than an omission.</p>
 */

import {WebDeepLinks} from './deep-links.web';

describe('WebDeepLinks', () => {
    it('reports no launch URL, because the address bar is the launch URL', async () => {
        expect(await new WebDeepLinks().initial()).toBeNull();
    });

    it('keeps reporting none, so nothing can be re-handled on a reload', async () => {
        const links = new WebDeepLinks();

        expect(await links.initial()).toBeNull();
        expect(await links.initial()).toBeNull();
    });

    it('resolves a working unsubscribe from onOpen so callers need no null check', async () => {
        const handler = vi.fn();

        const stop = await new WebDeepLinks().onOpen(handler);

        expect(typeof stop).toBe('function');
        expect(() => stop()).not.toThrow();
        expect(handler).not.toHaveBeenCalled();
    });
});
