import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {VoiceRingService} from './voice-ring.service';
import {ApiConfigService} from './api-config.service';

/**
 * The gateway strips its own `guild` segment and the Guild service's own routes start with
 * `/api/v1`, so the public path is `/api/v1/guild` + the service path. The ring guide writes the
 * prefix three different ways; these are pinned against what every other shipped guild call in this
 * client already uses.
 */
const BASE = 'https://api.test.example/api/v1/guild';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    return {service: TestBed.inject(VoiceRingService), ctrl: TestBed.inject(HttpTestingController)};
}

describe('VoiceRingService', () => {
    afterEach(() => {
        TestBed.inject(HttpTestingController).verify();
        TestBed.resetTestingModule();
    });

    it('rings into a channel, and says which delivery rather than relying on the default', () => {
        // The server defaults `delivery` to Both only for the sake of clients that predate the
        // field. Saying it means this request keeps its meaning if that default ever moves.
        const {service, ctrl} = setup();
        service.ring('g1', 'chan_1', 'user_ada').subscribe();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/channels/chan_1/voice/rings`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({targetUserId: 'user_ada', delivery: 'Both'});
        req.flush({});
    });

    it('invites through the same route with the quiet delivery', () => {
        // One endpoint, two acts. A message invitation rings nobody and creates no ring, and it
        // answers the conversation it landed in rather than something to count down.
        const {service, ctrl} = setup();
        service.invite('g1', 'chan_1', 'user_ada').subscribe();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/channels/chan_1/voice/rings`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({targetUserId: 'user_ada', delivery: 'Message'});
        req.flush({conversationId: 'conv_1'});
    });

    it('reads the pending rings from a flat route, since a woken phone knows only a ring id', () => {
        const {service, ctrl} = setup();
        service.pending().subscribe();

        const req = ctrl.expectOne(`${BASE}/guilds/voice/rings/pending`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('accepts and declines on their own routes - deliberately different acts', () => {
        const {service, ctrl} = setup();

        service.accept('ring_1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/voice/rings/ring_1/accept`).flush({});

        service.decline('ring_1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/voice/rings/ring_1/decline`).flush({});
    });

    it('cancels with a DELETE, which only the inviter may do', () => {
        const {service, ctrl} = setup();
        service.cancel('ring_1').subscribe();

        const req = ctrl.expectOne(`${BASE}/guilds/voice/rings/ring_1`);
        expect(req.request.method).toBe('DELETE');
        req.flush({});
    });
});
