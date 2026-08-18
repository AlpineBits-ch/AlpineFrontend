import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {ApiConfigService} from './api-config.service';
import {DraftApi, HttpDraftApi} from './draft-api.service';
import {MessageDraftDto} from '../dtos/response/draft.dto';

const BASE = 'https://api.test.example';

// The gateway strips one service segment, so the draft routes sit under a doubled prefix.
const DRAFTS = `${BASE}/api/v1/messaging/messaging/drafts`;

const DRAFT: MessageDraftDto = {
    contextId: 'chan_1',
    channelId: 'chan_1',
    conversationId: null,
    content: 'half a sentence',
    inReplyTo: null,
    updatedAt: '2026-08-18T10:00:00Z',
};

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: DraftApi, useClass: HttpDraftApi},
        ],
    });
    return {api: TestBed.inject(DraftApi), ctrl: TestBed.inject(HttpTestingController)};
}

describe('HttpDraftApi', () => {
    it('saves to the path the gateway leaves the messaging service', () => {
        const {api, ctrl} = setup();
        let saved: MessageDraftDto | null = null;
        api.save('chan_1', {content: 'half a sentence'}).subscribe(d => (saved = d));

        const req = ctrl.expectOne(`${DRAFTS}/chan_1`);
        expect(req.request.method).toBe('PUT');
        req.flush(DRAFT);

        expect(saved).toEqual(DRAFT);
        ctrl.verify();
    });

    it('reads and discards on the same path', () => {
        const {api, ctrl} = setup();
        api.get('chan_1').subscribe();
        expect(ctrl.expectOne(`${DRAFTS}/chan_1`).request.method).toBe('GET');

        api.discard('chan_1').subscribe();
        expect(ctrl.expectOne(`${DRAFTS}/chan_1`).request.method).toBe('DELETE');
        ctrl.verify();
    });

    it('answers null rather than failing when there is no draft', () => {
        const {api, ctrl} = setup();
        let result: MessageDraftDto | null | undefined;
        api.get('chan_1').subscribe(d => (result = d));

        ctrl.expectOne(`${DRAFTS}/chan_1`).flush(null, {status: 404, statusText: 'Not Found'});
        expect(result).toBeNull();
        ctrl.verify();
    });
});
