/** The catalog courier's failure modes, which are all silent ones. A 304 arrives as an `HttpErrorResponse`, and treating it as a failure leaves a client that already has the right catalog convinced it does not. */
import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {PresenceCatalog} from '../platform/ports/presence-catalog.port';
import {emptyCatalogState as state, FakePresenceCatalog} from '../platform/testing/fake-presence-catalog';
import {GameCatalogService} from './game-catalog.service';
import {ApiConfigService} from './api-config.service';
import {OsInfo} from '../platform/ports/os-info.port';
import {FakeOsInfo} from '../platform/testing/fake-os-info';

const BASE = 'https://venta.example';
const URL = `${BASE}/api/v1/social/games/catalog`;

/** Lets the awaited catalog-state round trip resolve, so the HTTP request has actually been issued by the time the test looks for it. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** How many of the warnings are ours. Angular emits its own on a failed request, so counting every `console.warn` would be counting the framework. */
function ourWarnings(warn: {mock: {calls: unknown[][]}}): number {
    return warn.mock.calls.filter(call => String(call[0]).includes('[GameCatalog]')).length;
}

let catalog: FakePresenceCatalog;

function setup(isMobile = false) {
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: OsInfo, useValue: new FakeOsInfo(isMobile ? 'android' : 'windows', isMobile)},
            {provide: PresenceCatalog, useValue: catalog},
        ],
    });
    return {
        service: TestBed.inject(GameCatalogService),
        http: TestBed.inject(HttpTestingController),
    };
}

describe('GameCatalogService', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        catalog = new FakePresenceCatalog();
    });

    it('fetches for the platform Rust asked for and hands the body back with its ETag', async () => {
        catalog.afterLoad = state({
            loaded: true,
            version: '7',
            etag: 'W/"abc"',
            stats: {games: 10445, rules: 11218, droppedWithoutApplicationId: 3},
        });
        const {service, http} = setup();

        const done = service.sync();
        await settle();
        const request = http.expectOne(r => r.url === URL);
        // The `os` comes from Rust so the platform mapping is not duplicated in two languages.
        expect(request.request.params.get('os')).toBe('win32');
        // Nothing cached yet, so no conditional header; sending one would be a lie.
        expect(request.request.headers.has('If-None-Match')).toBe(false);

        request.flush('{"version":"7","games":[]}', {headers: {ETag: 'W/"abc"'}});
        await done;

        expect(catalog.loads).toEqual([{json: '{"version":"7","games":[]}', etag: 'W/"abc"'}]);
        expect(service.state()?.loaded).toBe(true);
        expect(service.state()?.stats.games).toBe(10445);
        http.verify();
    });

    it('sends the cached ETag as If-None-Match', async () => {
        catalog.cached = state({loaded: true, etag: 'W/"v7"'});
        const {service, http} = setup();

        const done = service.sync();
        await settle();
        const request = http.expectOne(r => r.url === URL);
        expect(request.request.headers.get('If-None-Match')).toBe('W/"v7"');

        request.flush('{}', {status: 304, statusText: 'Not Modified'});
        await done;

        // The common path, and it must be a no-op rather than a reload of the same bytes.
        expect(catalog.loads).toEqual([]);
        http.verify();
    });

    it('leaves the existing catalog alone when the fetch fails', async () => {
        catalog.cached = state({loaded: true, etag: 'W/"v7"'});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const {service, http} = setup();

        const done = service.sync();
        await settle();
        http.expectOne(r => r.url === URL).flush('', {status: 503, statusText: 'Unavailable'});
        await done;

        expect(catalog.loads).toEqual([]);
        // Whatever Rust already had is still what it has: detection degrades to the cached catalog rather than to nothing.
        expect(service.state()?.loaded).toBe(true);
        expect(ourWarnings(warn)).toBe(1);
        warn.mockRestore();
    });

    it('warns once per session, not once per attempt', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const {service, http} = setup();

        for (let attempt = 0; attempt < 3; attempt++) {
            const done = service.sync();
            await settle();
            http.expectOne(r => r.url === URL).flush('', {status: 500, statusText: 'Error'});
            await done;
        }

        expect(ourWarnings(warn)).toBe(1);
        warn.mockRestore();
    });

    it('ignores a body that did not come back 200', async () => {
        const {service, http} = setup();

        const done = service.sync();
        await settle();
        http.expectOne(r => r.url === URL).flush(null, {status: 204, statusText: 'No Content'});
        await done;

        expect(catalog.loads).toEqual([]);
        http.verify();
    });

    /** Both halves of the guard, `!PresenceCatalog.supported` and `isMobile`, are still two questions: a Tauri phone build reports `supported` and would download 12 MB to feed a matcher that cannot enumerate a process. */
    it('does nothing off the desktop', async () => {
        catalog.supported = false;
        const {service, http} = setup();
        await service.sync();
        http.verify();

        TestBed.resetTestingModule();
        catalog.supported = true;
        // Mobile cannot enumerate processes at all, so a 12 MB download would buy nothing.
        const mobile = setup(true);
        await mobile.service.sync();
        mobile.http.verify();

        expect(catalog.stateCalls).toBe(0);
        expect(catalog.loads).toEqual([]);
    });

    it('collapses concurrent syncs into one request', async () => {
        const {service, http} = setup();

        const first = service.sync();
        // `start()` and a later retry can land in the same tick; two 12 MB downloads would not.
        const second = service.sync();
        await settle();

        http.expectOne(r => r.url === URL).flush('{"games":[]}');
        await Promise.all([first, second]);
        http.verify();
    });
});
