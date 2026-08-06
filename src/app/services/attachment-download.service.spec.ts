// vi.hoisted, because vi.mock is lifted above the imports and its factory therefore runs before
// any plain const in this file has been initialised.
const {save, writeFile} = vi.hoisted(() => ({save: vi.fn(), writeFile: vi.fn()}));

vi.mock('@tauri-apps/plugin-dialog', () => ({save: (options: unknown) => save(options)}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    writeFile: (path: string, data: Uint8Array) => writeFile(path, data),
}));

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {AttachmentDownloadService} from './attachment-download.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';
const DOWNLOAD_URL = `${BASE}/api/v1/messaging/attachments/a1/download`;

/** Lets the picker's promise settle and the download subscribe before the request is asserted. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function setup() {
    save.mockReset();
    writeFile.mockReset();
    writeFile.mockResolvedValue(undefined);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(AttachmentDownloadService),
        http: TestBed.inject(HttpTestingController),
    };
}

describe('AttachmentDownloadService', () => {
    it('asks for a destination and writes the bytes there', async () => {
        const {service, http} = setup();
        save.mockResolvedValue('C:\\Users\\someone\\Pictures\\holiday.png');

        const saved = service.save({id: 'a1', fileName: 'holiday.png'});
        await settle();

        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'image/png'}));
        expect(await saved).toBe(true);

        expect(save).toHaveBeenCalledWith(expect.objectContaining({defaultPath: 'holiday.png'}));
        const [dest, data] = writeFile.mock.calls[0] as unknown as [string, Uint8Array];
        expect(dest).toBe('C:\\Users\\someone\\Pictures\\holiday.png');
        expect(new TextDecoder().decode(data)).toBe('bytes');
        http.verify();
    });

    /**
     * The destination is chosen before the download starts, so dismissing the dialog must not have
     * already spent the user's bandwidth on a file that is then discarded.
     */
    it('downloads nothing when the dialog is dismissed', async () => {
        const {service, http} = setup();
        save.mockResolvedValue(null);

        expect(await service.save({id: 'a1', fileName: 'holiday.png'})).toBe(false);

        expect(writeFile).not.toHaveBeenCalled();
        http.expectNone(DOWNLOAD_URL);
        http.verify();
    });

    /** Windows appends the active filter's extension to a name typed without one. */
    it('offers a filter for the extension the file already has', async () => {
        const {service, http} = setup();
        save.mockResolvedValue('C:\\notes.pdf');

        const saved = service.save({id: 'a1', fileName: 'notes.pdf'});
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes']));
        await saved;

        expect(save).toHaveBeenCalledWith(expect.objectContaining({
            filters: [{name: 'PDF', extensions: ['pdf']}],
        }));
        http.verify();
    });

    it('offers no filter for a name without an extension', async () => {
        const {service, http} = setup();
        save.mockResolvedValue('C:\\dump');

        const saved = service.save({id: 'a1', fileName: 'dump'});
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes']));
        await saved;

        expect(save).toHaveBeenCalledWith(expect.objectContaining({filters: []}));
        http.verify();
    });
});
