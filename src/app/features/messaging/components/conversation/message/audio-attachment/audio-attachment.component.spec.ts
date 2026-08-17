import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';

import {AudioAttachmentComponent} from './audio-attachment.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';

const BASE = 'https://api.test.example';
const DOWNLOAD_URL = `${BASE}/api/v1/messaging/attachments/atac_1/download`;

/** Lets the fetch promise and its `.then` run before the request is asserted. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(contentType = 'audio/wav'): {
    fixture: ComponentFixture<AudioAttachmentComponent>;
    component: AudioAttachmentComponent;
    http: HttpTestingController;
} {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [AudioAttachmentComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    const fixture = TestBed.createComponent(AudioAttachmentComponent);
    fixture.componentRef.setInput('attachmentId', 'atac_1');
    fixture.componentRef.setInput('fileName', 'clip.wav');
    fixture.componentRef.setInput('contentType', contentType);
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance, http: TestBed.inject(HttpTestingController)};
}

describe('AudioAttachmentComponent', () => {
    beforeEach(() => {
        // jsdom implements neither, and an unhandled "not implemented" would fail the run before
        // the assertion it is standing in the way of.
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        HTMLMediaElement.prototype.pause = vi.fn();
    });

    /**
     * A channel can hold a dozen clips in the scrollback, and the whole file comes down at once -
     * so nothing may be fetched until somebody asks to hear it.
     */
    it('fetches nothing until play is pressed', () => {
        const {http} = setup();
        http.expectNone(DOWNLOAD_URL);
        http.verify();
    });

    /**
     * Built from the id, never from an attachment URL: the payload does not carry one, and the
     * `thumbnailUrl` that is there points at a preview that for a sound file does not exist.
     */
    it('downloads by attachment id on the first play', async () => {
        const {component, http} = setup();

        const played = component['toggle']();
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'audio/wav'}));
        await played;

        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
        http.verify();
    });

    it('does not download again when playback is resumed', async () => {
        const {component, http} = setup();

        const played = component['toggle']();
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'audio/wav'}));
        await played;

        await component['toggle']();
        await settle();

        http.expectNone(DOWNLOAD_URL);
        http.verify();
    });

    /**
     * The download route answers `application/octet-stream` for anything it could not sniff. A blob
     * carrying that type tells the element nothing about the codec and it refuses the source, which
     * is the "couldn't play this file" on a file that plays fine everywhere else.
     */
    it('relabels an untyped response with the type the attachment declares', async () => {
        const {component, http} = setup('audio/wav');
        const created = vi.spyOn(URL, 'createObjectURL');

        const played = component['toggle']();
        await settle();
        http.expectOne(DOWNLOAD_URL)
            .flush(new Blob(['bytes'], {type: 'application/octet-stream'}));
        await played;

        expect(created).toHaveBeenCalledOnce();
        expect((created.mock.calls[0][0] as Blob).type).toBe('audio/wav');
        created.mockRestore();
        http.verify();
    });

    /** A server that did send a real audio type knows better than the uploader's guess. */
    it('leaves a response that already has an audio type alone', async () => {
        const {component, http} = setup('audio/mpeg');
        const created = vi.spyOn(URL, 'createObjectURL');

        const played = component['toggle']();
        await settle();
        http.expectOne(DOWNLOAD_URL).flush(new Blob(['bytes'], {type: 'audio/wav'}));
        await played;

        expect((created.mock.calls[0][0] as Blob).type).toBe('audio/wav');
        created.mockRestore();
        http.verify();
    });

    it('reports the status when the download fails', async () => {
        const {component, http} = setup();

        const played = component['toggle']();
        await settle();
        http.expectOne(DOWNLOAD_URL)
            .flush(new Blob([]), {status: 403, statusText: 'Forbidden'});
        await played;

        expect(component['failed']()).toBe(true);
        expect(component['failureDetail']()).toBe('HTTP 403');
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        http.verify();
    });

    describe('volume', () => {
        afterEach(() => {
            // Shared across every instance by design, so a test that moves it has to put it back.
            setup().component['volume'].set(1);
        });

        it('starts a new player at the level the last one was left at', () => {
            const first = setup().component;
            first['volume'].set(0.25);

            expect(setup().component['volume']()).toBe(0.25);
        });

        /** Muting something already at zero would be a no-op the icon claims it undid. */
        it('restores an audible level when unmuting from zero', () => {
            const {component} = setup();
            component['volume'].set(0);

            component['toggleMute']();

            expect(component['volume']()).toBe(1);
            expect(component['muted']()).toBe(false);
        });
    });
});
