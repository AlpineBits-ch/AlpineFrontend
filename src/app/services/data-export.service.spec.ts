/**
 * Which download path a host gets, and what happens when it asks for one it does not have.
 * `saveToDisk` must go through the native HTTP client: the endpoint 302s to a signed GCS URL with
 * no `Access-Control-Allow-Origin`, so a webview fetch is CORS-blocked. The web answer is a
 * capability gate and a typed refusal, never a silent no-op.
 */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {OsInfo} from '../platform/ports/os-info.port';
import {FakeOsInfo} from '../platform/testing/fake-os-info';
import {ApiConfigService} from './api-config.service';
import {AuthService} from './auth.service';
import {DataExportSaveUnsupportedError, DataExportService, downloadErrorStatus} from './data-export.service';

const BASE = 'https://api.test.example';

function setup(kind: OsInfo['kind'], isMobile = false) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {
                provide: AuthService,
                useValue: {ensureValidToken: async () => 'tok', refresh: async () => 'tok2'},
            },
            {provide: OsInfo, useValue: new FakeOsInfo(kind, isMobile)},
        ],
    });
    return {
        service: TestBed.inject(DataExportService),
        http: TestBed.inject(HttpTestingController),
    };
}

describe('DataExportService.canSaveToDisk', () => {
    it('is true on a desktop shell', () => {
        expect(setup('windows').service.canSaveToDisk).toBe(true);
        expect(setup('macos').service.canSaveToDisk).toBe(true);
        expect(setup('linux').service.canSaveToDisk).toBe(true);
    });

    it('is false in a browser', () => {
        expect(setup('web').service.canSaveToDisk).toBe(false);
    });

    /**
     * Both halves of the gate matter: the Rust command exists in the mobile shell too, so the host
     * check is not redundant.
     */
    it('is false on a phone even though the native command exists there', () => {
        expect(setup('ios', true).service.canSaveToDisk).toBe(false);
        expect(setup('android', true).service.canSaveToDisk).toBe(false);
    });
});

describe('DataExportService on a host without the native path', () => {
    it('refuses to write to disk with a typed error', async () => {
        const {service} = setup('web');

        await expect(service.saveToDisk('e1', '/tmp/export.zip')).rejects.toBeInstanceOf(
            DataExportSaveUnsupportedError,
        );
    });

    it('refuses the picker flow the same way', async () => {
        const {service} = setup('web');

        await expect(service.saveToDiskWithPicker('e1', 'export.zip')).rejects.toBeInstanceOf(
            DataExportSaveUnsupportedError,
        );
    });

    /**
     * The refusal carries the {@link DataExportDownloadError} shape, so it flows through the
     * existing error reporting. `status: null` is honest: nothing answered, because nothing asked.
     */
    it('reports no status, because no request was made', async () => {
        const {service} = setup('web');

        const err = await service.saveToDisk('e1', '/tmp/export.zip').catch((e: unknown) => e);

        expect(downloadErrorStatus(err)).toBeNull();
        expect((err as DataExportSaveUnsupportedError).message).toContain('web');
    });

    /** The browser path still works, and is the one such a host is expected to use. */
    it('still downloads the artifact as a blob', async () => {
        const {service, http} = setup('web');
        const seen: Blob[] = [];

        service.download('e1').subscribe(blob => seen.push(blob));
        http.expectOne(`${BASE}/api/v1/identity/data-exports/e1/download`).flush(
            new Blob(['zip bytes'], {type: 'application/zip'}),
        );

        expect(seen).toHaveLength(1);
        http.verify();
    });
});
