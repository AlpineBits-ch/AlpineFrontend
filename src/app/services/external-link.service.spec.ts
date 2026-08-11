/**
 * The link service is now a delegate over {@link LinkOpener}, and this spec pins the one behaviour it
 * still owns: it swallows failures.
 *
 * <p>That is worth a test rather than a comment because it looks like a bug. Almost every caller invokes
 * this as `void openExternalLink(...)` from a click handler, so a rejection escaping here becomes an
 * unhandled promise rejection and, in production, a Sentry report - for a link that failed to open, which
 * is nothing the user can act on and nothing the app can retry.</p>
 */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {LinkOpener} from '../platform/ports/link-opener.port';
import {FakeLinkOpener} from '../platform/testing/fake-link-opener';
import {ExternalLinkService} from './external-link.service';

function setup() {
    const opener = new FakeLinkOpener();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            {provide: LinkOpener, useValue: opener},
        ],
    });
    return {service: TestBed.inject(ExternalLinkService), opener};
}

describe('ExternalLinkService', () => {
    it('hands the URL to the host', async () => {
        const {service, opener} = setup();

        await service.openExternalLink('https://venta.gg/legal/terms');

        expect(opener.opened).toEqual(['https://venta.gg/legal/terms']);
    });

    it('resolves rather than rejecting when the host cannot open the link', async () => {
        const {service, opener} = setup();
        opener.error = new Error('no handler for this scheme');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(service.openExternalLink('https://venta.gg')).resolves.toBeUndefined();

        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });

    /**
     * It does not second-guess the URL either. Which schemes are openable is the adapter's decision, and
     * it differs by host: a browser must refuse `javascript:`, while the desktop shell hands the string
     * to the OS. Filtering here as well would put that rule in two places that could disagree.
     */
    it('passes the URL through unexamined', async () => {
        const {service, opener} = setup();

        await service.openExternalLink('mailto:support@venta.gg');

        expect(opener.opened).toEqual(['mailto:support@venta.gg']);
    });
});
