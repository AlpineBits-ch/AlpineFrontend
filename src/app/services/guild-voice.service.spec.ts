import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {ApiConfigService} from './api-config.service';
import {GuildVoiceService, VoiceConnectionDto, VoicePublishResponse} from './guild-voice.service';

const BASE = 'https://api.test.example';
const GUILD = 'g1';
const CHANNEL = 'c1';

/**
 * The gateway rewrite: one singular `guild` segment, then the plural resource. Written out once,
 * literally, because every assertion below is about the exact string - a path the gateway does not
 * recognise 404s silently rather than erroring anywhere a test would see it.
 */
const VOICE = `${BASE}/api/v1/guild/guilds/${GUILD}/channels/${CHANNEL}/voice`;

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
        service: TestBed.inject(GuildVoiceService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

const CONNECTION: VoiceConnectionDto = {
    backend: 'livekit',
    url: 'wss://sfu-fsn1.venta.gg',
    token: 'eyJhbGciOiJIUzI1NiIs',
    room: 'channel-c1',
    identity: 'user-1',
    mediaSessionId: 'user-1',
    expiresAt: '2026-08-16T12:10:00Z',
    canPublishAudio: true,
    canPublishVideo: false,
};

describe('GuildVoiceService', () => {
    describe('connection', () => {
        it('POSTs the connection route with primary on the query string', () => {
            const {service, ctrl} = setup();
            let got: VoiceConnectionDto | undefined;
            service.connection(GUILD, CHANNEL).subscribe(c => got = c);

            const req = ctrl.expectOne(`${VOICE}/connection?primary=true`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({});
            req.flush(CONNECTION);

            expect(got).toEqual(CONNECTION);
            ctrl.verify();
        });

        it('carries primary=false and the tag for a secondary connection', () => {
            const {service, ctrl} = setup();
            service.connection(GUILD, CHANNEL, false, 'view').subscribe();

            const req = ctrl.expectOne(`${VOICE}/connection?primary=false&tag=view`);
            expect(req.request.method).toBe('POST');
            req.flush(CONNECTION);
            ctrl.verify();
        });

        it('omits tag entirely rather than sending an empty one', () => {
            // A blank tag is not the same request as no tag: the server falls back to `alt` for
            // anything that survives stripping as empty, so an always-present `&tag=` would hand
            // every tagless secondary connection the same identity.
            const {service, ctrl} = setup();
            service.connection(GUILD, CHANNEL, false).subscribe();

            ctrl.expectOne(`${VOICE}/connection?primary=false`).flush(CONNECTION);
            ctrl.verify();
        });

        it('escapes a tag rather than pasting it into the query string', () => {
            const {service, ctrl} = setup();
            service.connection(GUILD, CHANNEL, false, 'a b&c').subscribe();

            ctrl.expectOne(`${VOICE}/connection?primary=false&tag=a%20b%26c`).flush(CONNECTION);
            ctrl.verify();
        });

        it('reads canPublish* off the reply, since that is what the token grants', () => {
            const {service, ctrl} = setup();
            let got: VoiceConnectionDto | undefined;
            service.connection(GUILD, CHANNEL).subscribe(c => got = c);

            ctrl.expectOne(`${VOICE}/connection?primary=true`).flush(CONNECTION);
            expect(got?.canPublishAudio).toBe(true);
            expect(got?.canPublishVideo).toBe(false);
            ctrl.verify();
        });
    });

    describe('publish', () => {
        it('POSTs the publish route with the track names', () => {
            const {service, ctrl} = setup();
            service.publish(GUILD, CHANNEL, {trackNames: ['audio']}).subscribe();

            const req = ctrl.expectOne(`${VOICE}/publish`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({trackNames: ['audio']});
            req.flush({identity: 'user-1', rung: null, height: null, framerate: null, maxLayer: null});
            ctrl.verify();
        });

        it('declares the video intent in the same call as the tracks', () => {
            const {service, ctrl} = setup();
            service.publish(GUILD, CHANNEL, {
                trackNames: ['screen-abc', 'screen-audio-abc'],
                video: {height: 1080, framerate: 60},
            }).subscribe();

            const req = ctrl.expectOne(`${VOICE}/publish`);
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
            service.publish(GUILD, CHANNEL, {trackNames: ['video'], video: {height: 1080, framerate: 60}})
                .subscribe(r => got = r);

            ctrl.expectOne(`${VOICE}/publish`).flush({
                identity: 'user-1', rung: '720p30', height: 720, framerate: 30, maxLayer: 'b',
                degradations: [{key: 'voice.video_ceiling'}],
            });

            // The publish succeeded, smaller. `rung` is what to re-encode to and `maxLayer` says
            // nobody is served above `b` until it is.
            expect(got?.rung).toBe('720p30');
            expect(got?.maxLayer).toBe('b');
            expect(got?.degradations).toHaveLength(1);
            ctrl.verify();
        });

        it('surfaces a 403 rather than swallowing it - the token refuses it too', () => {
            const {service, ctrl} = setup();
            let status: number | undefined;
            service.publish(GUILD, CHANNEL, {trackNames: ['video']})
                .subscribe({error: err => status = err.status});

            ctrl.expectOne(`${VOICE}/publish`)
                .flush({code: 'guild_plan_limit', key: 'voice.video_ceiling'},
                    {status: 403, statusText: 'Forbidden'});

            expect(status).toBe(403);
            ctrl.verify();
        });
    });

    describe('unpublish', () => {
        it('POSTs the unpublish route with the track names', () => {
            const {service, ctrl} = setup();
            service.unpublish(GUILD, CHANNEL, ['screen-abc']).subscribe();

            const req = ctrl.expectOne(`${VOICE}/unpublish`);
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
            service.declareVideo(GUILD, CHANNEL, {height: 1440, framerate: 60})
                .subscribe(r => maxLayer = r.maxLayer);

            const req = ctrl.expectOne(`${VOICE}/video`);
            expect(req.request.method).toBe('PUT');
            expect(req.request.body).toEqual({height: 1440, framerate: 60});
            req.flush({changed: true, maxLayer: 'b'});

            expect(maxLayer).toBe('b');
            ctrl.verify();
        });
    });

    it('still asserts liveness on the alive route', () => {
        const {service, ctrl} = setup();
        service.alive(GUILD, CHANNEL).subscribe();

        const req = ctrl.expectOne(`${VOICE}/alive`);
        expect(req.request.method).toBe('POST');
        req.flush(null);
        ctrl.verify();
    });

    it('carries no SDP-relay surface at all', () => {
        // Not tidiness: the backend answers 404 on every one of these now, so a caller that still
        // reaches for one gets a silent nothing at the gateway rather than a compile error.
        const {service} = setup();
        const legacy = service as unknown as Record<string, unknown>;
        expect(legacy['createSession']).toBeUndefined();
        expect(legacy['negotiateTracks']).toBeUndefined();
        expect(legacy['renegotiate']).toBeUndefined();
        expect(legacy['closeTracks']).toBeUndefined();
    });
});
