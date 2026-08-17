import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {MessagingService} from './messaging.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(MessagingService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('MessagingService pinning', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('pinMessage POSTs to /messaging/messaging/{messageId}/pin with no body', () => {
        const {service, ctrl} = setup();
        service.pinMessage('m1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/m1/pin`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toBeNull();
        req.flush({success: true, pinnedById: 'u1', pinnedAt: '2026-07-30T00:00:00Z'});
    });

    it('unpinMessage DELETEs /messaging/messaging/{messageId}/pin', () => {
        const {service, ctrl} = setup();
        service.unpinMessage('m1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/m1/pin`);
        expect(req.request.method).toBe('DELETE');
        req.flush({success: true});
    });

    it('getPinnedMessages GETs pins filtered by channelId', () => {
        const {service, ctrl} = setup();
        service.getPinnedMessages({channelId: 'c1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/pins?channelId=c1`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('getPinnedMessages GETs pins filtered by conversationId', () => {
        const {service, ctrl} = setup();
        service.getPinnedMessages({conversationId: 'conv1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/pins?conversationId=conv1`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });
});

describe('MessagingService search', () => {
    let service: MessagingService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(MessagingService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('scopes a channel search with query params on the flat search route', () => {
        service.searchMessagesForChannel('c1', 'hello world').subscribe();
        const req = http.expectOne(
            r => r.url === 'https://api.test.example/api/v1/messaging/messaging/search',
        );
        expect(req.request.method).toBe('GET');
        expect(req.request.params.get('query')).toBe('hello world');
        expect(req.request.params.get('channelId')).toBe('c1');
        expect(req.request.params.get('conversationId')).toBeNull();
        req.flush([]);
    });

    it('scopes a conversation search the same way', () => {
        service.searchMessagesForConversation('v1', 'test').subscribe();
        const req = http.expectOne(
            r => r.url === 'https://api.test.example/api/v1/messaging/messaging/search',
        );
        expect(req.request.params.get('conversationId')).toBe('v1');
        expect(req.request.params.get('channelId')).toBeNull();
        req.flush([]);
    });

    it('sends the server-side maximum limit', () => {
        service.searchMessagesForChannel('c1', 'x').subscribe();
        const req = http.expectOne(r => r.url.endsWith('/search'));
        expect(req.request.params.get('limit')).toBe('50');
        req.flush([]);
    });
});
