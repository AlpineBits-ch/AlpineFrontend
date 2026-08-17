/** Saving an attachment, now that the host is behind {@link FileSaver}. The ordering it pins: the dialog first, and the download only once there is somewhere to put it. */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {FileSaver} from '../platform/ports/file-saver.port';
import {FakeFileSaver} from '../platform/testing/fake-file-saver';
import {AttachmentDownloadService, attachmentSavedToastKey} from './attachment-download.service';
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

    /** No MIME type, deliberately: the server's content type is not known until after `saveLazy`'s arguments are fixed, and each host's default is the better answer anyway. */
    it('declares no MIME type, because it is not known before the fetch', async () => {
        const {service, http, saver} = setup();

        const saved = service.save({id: 'a1', fileName: 'notes.pdf'});
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'application/pdf'}));
        await saved;

        expect(saver.onlyCall.mime).toBeUndefined();
        http.verify();
    });

    /** The assertion this service exists to keep: on a host that can ask first, dismissing the dialog means the fetch never happens at all, so `produceCalls` staying at zero is the whole guarantee. */
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
        // A Blob body even for the error: the request asks for `responseType: 'blob'`, and the testing backend refuses to convert a string for it.
        http.expectOne(DOWNLOAD_URL)
            .flush(new Blob(['nope']), {status: 500, statusText: 'Server Error'});

        await expect(saved).rejects.toBeTruthy();
        expect(saver.calls).toHaveLength(0);
        http.verify();
    });
});

/** What the confirmation toast may claim, per host: `true` from a browser save means "handed to the download manager", not "saved", because a browser reports no cancellation at all. */
describe('attachmentSavedToastKey', () => {
    it('claims a save on a host whose dialog can be cancelled', () => {
        expect(attachmentSavedToastKey('tauri')).toBe('MESSAGE.DOWNLOAD_SAVED');
    });

    it('claims only a started download in a browser', () => {
        expect(attachmentSavedToastKey('web')).toBe('MESSAGE.DOWNLOAD_STARTED');
    });

    it('says something different on each host, which is the whole point', () => {
        expect(attachmentSavedToastKey('web')).not.toBe(attachmentSavedToastKey('tauri'));
    });
});
