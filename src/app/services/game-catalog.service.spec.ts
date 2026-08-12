/**
 * The catalog courier's failure modes, which are all silent ones.
 *
 * <p>Nothing here checks matching — that is Rust's, and it is tested there against the nasty data.
 * What is worth pinning on this side is the conditional-request handshake, because every way it can
 * go wrong looks identical from the outside: no catalog, no detection, no error. In particular a
 * 304 arrives as an `HttpErrorResponse`, and treating it as a failure would leave a client that
 * already has the right catalog permanently convinced it does not.</p>
 *
 * <p><b>On the fake.</b> This used to `vi.mock('@tauri-apps/api/core')`, with a note that several spec
 * files mock that module and only one registration wins per run - the values had to be set per test
 * because of it. A fake adapter in `providers` has no such problem: it is scoped to this TestBed and
 * invisible to every other file.</p>
 */
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

/**
 * Lets the awaited catalog-state round trip resolve, so the HTTP request has actually been issued by
 * the time the test looks for it. `sync()` asks Rust what it already holds *before* it can decide what
 * to request, so there is no synchronous moment at which the request exists.
 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * How many of the warnings are ours. Angular emits its own on a failed request, so counting every
 * `console.warn` would be counting the framework.
 */
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
        // Nothing cached yet, so no conditional header — sending one would be a lie.
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
        // Whatever Rust already had is still what it has: detection degrades to the cached catalog,
        // or to the legacy list, rather than to nothing.
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

    /**
     * Both halves of the guard, which used to be `!isTauri()` and `isMobile` and is now
     * `!PresenceCatalog.supported` and `isMobile`.
     *
     * <p>They are still two questions: a Tauri phone build has a real adapter and reports `supported`,
     * and would happily download 12 MB to feed a matcher that cannot enumerate a process. Reaching the
     * adapter at all is the failure, which is why this asserts on `stateCalls` rather than only on the
     * absence of a request - the web adapter rejects, so a missing guard would surface as a rejected
     * promise rather than as a quiet no-op.</p>
     */
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
