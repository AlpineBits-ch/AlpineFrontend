import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {ChannelFollowService} from './channel-follow.service';
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
        service: TestBed.inject(ChannelFollowService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('ChannelFollowService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('follow POSTs to /guild/channels/{sourceChannelId}/followers with targetChannelId body', () => {
        const {service, ctrl} = setup();
        service.follow('src1', 'tgt1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/guild/channels/src1/followers`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({targetChannelId: 'tgt1'});
        req.flush({id: 'f1', sourceChannelId: 'src1', targetChannelId: 'tgt1'});
    });

    it('listFollowers GETs /guild/channels/{sourceChannelId}/followers', () => {
        const {service, ctrl} = setup();
        service.listFollowers('src1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/guild/channels/src1/followers`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('unfollow DELETEs /guild/channels/{sourceChannelId}/followers/{followId}', () => {
        const {service, ctrl} = setup();
        service.unfollow('src1', 'f1').subscribe();
        const req = ctrl.expectOne(`${BASE}/api/v1/guild/channels/src1/followers/f1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
