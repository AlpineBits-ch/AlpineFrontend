import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {describe, expect, it} from 'vitest';
import {ApiConfigService} from './api-config.service';
import {VoiceConnectionDto, VoicePublishResponse} from './guild-voice.service';
import {VoiceService} from './voice.service';

const BASE = 'https://api.test.example';
const CALL = 'call1';

/** The media routes: plural `calls`. Getting this backwards 404s silently at the gateway. */
const MEDIA = `${BASE}/api/v1/messaging/voice/calls/${CALL}`;
/** The lifecycle routes, on the same service, singular. Both are correct; neither is a typo. */
const LIFECYCLE = `${BASE}/api/v1/messaging/voice/call/${CALL}`;

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(VoiceService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

const CONNECTION: VoiceConnectionDto = {
    backend: 'livekit',
    url: 'wss://sfu-fsn1.venta.gg',
    token: 'eyJhbGciOiJIUzI1NiIs',
    room: 'call-call1',
    identity: 'user-1',
    mediaSessionId: 'user-1',
    expiresAt: '2026-08-16T12:10:00Z',
    canPublishAudio: true,
    canPublishVideo: true,
};

describe('VoiceService', () => {
    describe('connection', () => {
        it('POSTs the plural media route with primary on the query string', () => {
            const {service, ctrl} = setup();
            let got: VoiceConnectionDto | undefined;
            service.connection(CALL).subscribe(c => got = c);

            const req = ctrl.expectOne(`${MEDIA}/connection?primary=true`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(CONNECTION);

            expect(got).toEqual(CONNECTION);
            ctrl.verify();
        });

        it('does not put the connection on the singular lifecycle path', () => {
            const {service, ctrl} = setup();
            service.connection(CALL).subscribe();

            ctrl.expectNone(`${LIFECYCLE}/connection?primary=true`);
            ctrl.expectOne(`${MEDIA}/connection?primary=true`).flush(CONNECTION);
            ctrl.verify();
        });

        it('carries primary=false and the tag for a secondary connection', () => {
            const {service, ctrl} = setup();
            service.connection(CALL, false, 'view').subscribe();

            const req = ctrl.expectOne(`${MEDIA}/connection?primary=false&tag=view`);
            expect(req.request.method).toBe('POST');
            req.flush(CONNECTION);
            ctrl.verify();
        });

        it('omits tag entirely rather than sending an empty one', () => {
            const {service, ctrl} = setup();
            service.connection(CALL, false).subscribe();

            ctrl.expectOne(`${MEDIA}/connection?primary=false`).flush(CONNECTION);
            ctrl.verify();
        });
    });

    describe('publish', () => {
        it('POSTs the publish route with the track names', () => {
            const {service, ctrl} = setup();
            service.publish(CALL, {trackNames: ['audio']}).subscribe();

            const req = ctrl.expectOne(`${MEDIA}/publish`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({trackNames: ['audio']});
            req.flush({identity: 'user-1', rung: null, height: null, framerate: null, maxLayer: null});
            ctrl.verify();
        });

        it('declares the video intent in the same call as the tracks', () => {
            const {service, ctrl} = setup();
            service.publish(CALL, {
                trackNames: ['screen-abc', 'screen-audio-abc'],
                video: {height: 1080, framerate: 60},
            }).subscribe();

            const req = ctrl.expectOne(`${MEDIA}/publish`);
            expect(req.request.body).toEqual({
                trackNames: ['screen-abc', 'screen-audio-abc'],
                video: {height: 1080, framerate: 60},
            });
            req.flush({identity: 'user-1', rung: '1080p60', height: 1080, framerate: 60, maxLayer: null});
            ctrl.verify();
        });

        it('hands back the degradations on a clamped 200 so the caller re-encodes', () => {
            const {service, ctrl} = setup();
            let got: VoicePublishResponse | undefined;
            service.publish(CALL, {trackNames: ['video'], video: {height: 1080, framerate: 60}})
                .subscribe(r => got = r);

            ctrl.expectOne(`${MEDIA}/publish`).flush({
                identity: 'user-1', rung: '720p30', height: 720, framerate: 30, maxLayer: 'b',
                degradations: [{key: 'voice.video_ceiling'}],
            });

            expect(got?.rung).toBe('720p30');
            expect(got?.maxLayer).toBe('b');
            expect(got?.degradations).toHaveLength(1);
            ctrl.verify();
        });

        it('surfaces a 403 rather than swallowing it - the token refuses it too', () => {
            const {service, ctrl} = setup();
            let status: number | undefined;
            service.publish(CALL, {trackNames: ['video']})
                .subscribe({error: (err: {status: number}) => status = err.status});

            ctrl.expectOne(`${MEDIA}/publish`)
                .flush({code: 'user_plan_limit', key: 'voice.video_ceiling'},
                    {status: 403, statusText: 'Forbidden'});

            expect(status).toBe(403);
            ctrl.verify();
        });
    });

    describe('unpublish', () => {
        it('POSTs the unpublish route with the track names', () => {
            const {service, ctrl} = setup();
            service.unpublish(CALL, ['screen-abc']).subscribe();

            const req = ctrl.expectOne(`${MEDIA}/unpublish`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({trackNames: ['screen-abc']});
            req.flush(null, {status: 204, statusText: 'No Content'});
            ctrl.verify();
        });
    });

    describe('declareVideo', () => {
        it('PUTs the video route - a POST here 404s', () => {
            const {service, ctrl} = setup();
            let maxLayer: string | null | undefined;
            service.declareVideo(CALL, {height: 1440, framerate: 60})
                .subscribe(r => maxLayer = r.maxLayer);

            const req = ctrl.expectOne(`${MEDIA}/video`);
            expect(req.request.method).toBe('PUT');
            expect(req.request.body).toEqual({height: 1440, framerate: 60});
            req.flush({changed: true, maxLayer: 'b'});

            expect(maxLayer).toBe('b');
            ctrl.verify();
        });
    });

    it('still asserts liveness on the plural alive route', () => {
        const {service, ctrl} = setup();
        service.alive(CALL).subscribe();

        const req = ctrl.expectOne(`${MEDIA}/alive`);
        expect(req.request.method).toBe('POST');
        req.flush(null);
        ctrl.verify();
    });

    it('leaves the singular lifecycle routes exactly where they were', () => {
        // The plural/singular split is the documented trap, so the half that did not move is worth
        // pinning too: a well-meant tidy-up of one of these is a 404 nothing else would catch.
        const {service, ctrl} = setup();
        service.getCall(CALL).subscribe();
        ctrl.expectOne(LIFECYCLE).flush({});

        service.getCallSnapshot(CALL).subscribe();
        ctrl.expectOne(`${LIFECYCLE}/snapshot`).flush({});

        service.leaveCall(CALL).subscribe();
        expect(ctrl.expectOne(`${LIFECYCLE}/leave`).request.method).toBe('PUT');
        ctrl.verify();
    });

    it('carries no SDP-relay surface at all', () => {
        // The backend 404s every one of these now: a caller that still reaches for one gets silence
        // at the gateway rather than a compile error.
        const {service} = setup();
        const legacy = service as unknown as Record<string, unknown>;
        expect(legacy['cfCreateSession']).toBeUndefined();
        expect(legacy['cfTracksNew']).toBeUndefined();
        expect(legacy['cfRenegotiate']).toBeUndefined();
        expect(legacy['cfCloseTracks']).toBeUndefined();
    });
});
