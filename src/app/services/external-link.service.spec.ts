/** The link service is a delegate over {@link LinkOpener}, and this spec pins the one behaviour it still owns: it swallows failures, because callers invoke it as `void openExternalLink(...)` from click handlers. */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {LinkOpener} from '../platform/ports/link-opener.port';
import {FakeLinkOpener} from '../platform/testing/fake-link-opener';
import {ExternalLinkService} from './external-link.service';

function setup() {
    const opener = new FakeLinkOpener();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), {provide: LinkOpener, useValue: opener}],
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

    /** Which schemes are openable is the adapter's decision and differs by host, so filtering here as well would put the rule in two places that could disagree. */
    it('passes the URL through unexamined', async () => {
        const {service, opener} = setup();

        await service.openExternalLink('mailto:support@venta.gg');

        expect(opener.opened).toEqual(['mailto:support@venta.gg']);
    });
});
