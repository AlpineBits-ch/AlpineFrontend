/**
 * Saving an attachment, now that the host is behind {@link FileSaver}.
 *
 * <p>No `vi.mock('@tauri-apps/plugin-dialog')` here any more: the two plugin mocks this spec used to
 * hoist are replaced by a fake adapter provided in TestBed. That is strictly better and not only
 * tidier - the old spec asserted on the arguments to a Tauri dialog, so it could only ever describe the
 * desktop host, and the question that matters now ("are the right bytes handed over, under the right
 * name") is the same question on both.</p>
 *
 * <p>The filter-derivation cases that used to live here moved to `platform/tauri/file-saver.tauri.spec.ts`,
 * where the dialog they describe actually lives.</p>
 *
 * <p>The service saves through {@link FileSaver.saveLazy}, so the ordering it always had is intact: the
 * dialog first, and the download only once there is somewhere to put it. The cancel case below is what
 * holds that in place.</p>
 */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {FileSaver} from '../platform/ports/file-saver.port';
import {FakeFileSaver} from '../platform/testing/fake-file-saver';
import {AttachmentDownloadService} from './attachment-download.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';
const DOWNLOAD_URL = `${BASE}/api/v1/messaging/attachments/a1/download`;

/** Lets the fetch subscribe and the promise chain settle before anything is asserted. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function setup() {
    const saver = new FakeFileSaver();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: FileSaver, useValue: saver},
        ],
    });
    return {
        service: TestBed.inject(AttachmentDownloadService),
        http: TestBed.inject(HttpTestingController),
        saver,
    };
}

describe('AttachmentDownloadService', () => {
    it('hands the fetched bytes to the host under the offered name', async () => {
        const {service, http, saver} = setup();

        const saved = service.save({id: 'a1', fileName: 'holiday.png'});
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'image/png'}));

        expect(await saved).toBe(true);
        expect(saver.onlyCall.name).toBe('holiday.png');
        expect(saver.onlyCallAsText()).toBe('bytes');
        http.verify();
    });

    /**
     * No MIME type, deliberately. The server's content type is not known until the response arrives,
     * which is inside the producer and therefore after `saveLazy`'s arguments are fixed. Each host's
     * default is the better answer anyway: the desktop shell reads the type from the extension, and an
     * opaque type on web is what stops a browser sniffing a saved file as something it can render.
     */
    it('declares no MIME type, because it is not known before the fetch', async () => {
        const {service, http, saver} = setup();

        const saved = service.save({id: 'a1', fileName: 'notes.pdf'});
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'application/pdf'}));
        await saved;

        expect(saver.onlyCall.mime).toBeUndefined();
        http.verify();
    });

    /**
     * <b>The assertion this service exists to keep.</b> Dismissing the dialog must not have already spent
     * the user's bandwidth on a file that is then discarded - so on a host that can ask first, the fetch
     * never happens at all. `produceCalls` staying at zero is the whole guarantee, and `http.verify()`
     * says the same thing from the other side: no request was ever made.
     *
     * <p>This replaces an earlier assertion that pinned the opposite ordering. {@link FileSaver.save}
     * takes its bytes as an argument, which forced a fetch-then-ask shape and made a cancel cost a
     * completed download; {@link FileSaver.saveLazy} exists to undo that, and this is the test that
     * catches it regressing.</p>
     */
    it('downloads nothing when the dialog is dismissed', async () => {
        const {service, http, saver} = setup();
        saver.cancelled = true;

        expect(await service.save({id: 'a1', fileName: 'holiday.png'})).toBe(false);

        expect(saver.produceCalls).toBe(0);
        expect(saver.calls).toEqual([]);
        http.expectNone(DOWNLOAD_URL);
        http.verify();
    });

    /** And on the host that cannot defer, the fetch happens and the save still succeeds. */
    it('still saves on a host that must produce the bytes first', async () => {
        const {service, http, saver} = setup();
        saver.produceEagerly = true;

        const saved = service.save({id: 'a1', fileName: 'holiday.png'});
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes']));

        expect(await saved).toBe(true);
        expect(saver.produceCalls).toBe(1);
        expect(saver.onlyCallAsText()).toBe('bytes');
        http.verify();
    });

    /** A failed fetch rejects through the producer, and nothing is handed over to be written. */
    it('rejects without saving when the download fails', async () => {
        const {service, http, saver} = setup();

        const saved = service.save({id: 'a1', fileName: 'holiday.png'});
        await settle();
        // A Blob body even for the error: the request asks for `responseType: 'blob'`, and the testing
        // backend refuses to convert a string for it rather than quietly handing back something else.
        http.expectOne(DOWNLOAD_URL)
            .flush(new Blob(['nope']), {status: 500, statusText: 'Server Error'});

        await expect(saved).rejects.toBeTruthy();
        expect(saver.calls).toHaveLength(0);
        http.verify();
    });
});
