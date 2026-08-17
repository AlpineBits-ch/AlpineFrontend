import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {ApiConfigService} from './api-config.service';
import {WatchScope} from './share-watch.service';
import {VOICE_ALIVE_INTERVAL_MS, VoiceLivenessService} from './voice-liveness.service';

const BASE = 'https://api.test.example';
const CHANNEL_URL = `${BASE}/api/v1/guild/guilds/g1/channels/c1/voice/alive`;
const CALL_URL = `${BASE}/api/v1/messaging/voice/calls/call1/alive`;

const CHANNEL: WatchScope = {kind: 'channel', guildId: 'g1', channelId: 'c1'};
const CALL: WatchScope = {kind: 'call', callId: 'call1'};

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    const service = TestBed.inject(VoiceLivenessService);
    const evicted: WatchScope[] = [];
    service.evicted.subscribe(scope => evicted.push(scope));
    return {service, ctrl: TestBed.inject(HttpTestingController), evicted};
}

describe('VoiceLivenessService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('asserts liveness the instant the room is joined, not an interval later', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);

        // The window this exists to cover: SignalR is down at join time, and a client that waits
        // 30s before its first HTTP assertion is unprotected for exactly that stretch.
        const req = ctrl.expectOne(CHANNEL_URL);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({});
        req.flush({});
        ctrl.verify();
    });

    it('holds off the second assertion until the full interval has passed', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        ctrl.expectOne(CHANNEL_URL).flush({});

        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS - 1);
        ctrl.expectNone(CHANNEL_URL);

        vi.advanceTimersByTime(1);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.verify();
    });

    it('keeps asserting on every interval for as long as the room is held', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        ctrl.expectOne(CHANNEL_URL).flush({});

        for (let tick = 0; tick < 3; tick++) {
            vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS);
            ctrl.expectOne(CHANNEL_URL).flush({});
        }
        ctrl.verify();
    });

    it('posts a call to the plural media route', () => {
        const {service, ctrl} = setup();
        service.start(CALL);

        // Plural `calls/`, against the singular `call/` of the lifecycle routes. Getting it
        // backwards 404s at the gateway - which this service would then read as an eviction.
        ctrl.expectOne(CALL_URL).flush({});
        ctrl.verify();
    });

    it('runs the two room kinds side by side', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        service.start(CALL);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.expectOne(CALL_URL).flush({});

        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.expectOne(CALL_URL).flush({});
        ctrl.verify();
    });

    it('ignores a second start for a room it is already asserting', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        ctrl.expectOne(CHANNEL_URL).flush({});

        // A rejoin of the room already held must not arm a second interval: two tickers would
        // double the request rate and never be stopped by the one `stop` the caller makes.
        service.start(CHANNEL);
        ctrl.expectNone(CHANNEL_URL);

        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.verify();
    });

    it('reports a 404 as an eviction, because the server has no such participant', () => {
        const {service, ctrl, evicted} = setup();
        service.start(CHANNEL);
        ctrl.expectOne(CHANNEL_URL).flush('gone', {status: 404, statusText: 'Not Found'});

        expect(evicted).toEqual([CHANNEL]);
        // And it stops on its own: nothing is gained by asserting into a room we are not in.
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS * 3);
        ctrl.expectNone(CHANNEL_URL);
        ctrl.verify();
    });

    it('reports a 409 as an eviction, because another device holds this seat', () => {
        const {service, ctrl, evicted} = setup();
        service.start(CALL);
        ctrl.expectOne(CALL_URL).flush('conflict', {status: 409, statusText: 'Conflict'});

        expect(evicted).toEqual([CALL]);
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS * 3);
        ctrl.expectNone(CALL_URL);
        ctrl.verify();
    });

    it('does not evict on a server error, and keeps asserting', () => {
        const {service, ctrl, evicted} = setup();
        service.start(CHANNEL);
        ctrl.expectOne(CHANNEL_URL).flush('boom', {status: 500, statusText: 'Server Error'});

        // A transient failure is not an eviction. Tearing the room down here turns a blip on one
        // request into a dropped call, which is strictly worse than the outage it reacted to.
        expect(evicted).toEqual([]);
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.verify();
    });

    it('does not evict when the request never reaches the server', () => {
        const {service, ctrl, evicted} = setup();
        service.start(CHANNEL);
        // Status 0 - offline, DNS, a dropped Wi-Fi link. The one thing it is not is an answer.
        ctrl.expectOne(CHANNEL_URL).error(new ProgressEvent('error'));

        expect(evicted).toEqual([]);
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.verify();
    });

    it('leaves no timer running once the room is left', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        ctrl.expectOne(CHANNEL_URL).flush({});

        service.stop(CHANNEL);
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS * 5);
        ctrl.expectNone(CHANNEL_URL);
        expect(vi.getTimerCount()).toBe(0);
        ctrl.verify();
    });

    it('stops one room without touching the other', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        service.start(CALL);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.expectOne(CALL_URL).flush({});

        service.stop(CHANNEL);
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS);
        ctrl.expectNone(CHANNEL_URL);
        ctrl.expectOne(CALL_URL).flush({});
        ctrl.verify();
    });

    it('ignores a stop for a room it never started', () => {
        const {service, ctrl} = setup();
        service.stop(CHANNEL);
        ctrl.expectNone(CHANNEL_URL);
        ctrl.verify();
    });

    it('drops every ticker on teardown', () => {
        const {service, ctrl} = setup();
        service.start(CHANNEL);
        service.start(CALL);
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.expectOne(CALL_URL).flush({});

        service.ngOnDestroy();
        vi.advanceTimersByTime(VOICE_ALIVE_INTERVAL_MS * 5);
        ctrl.expectNone(CHANNEL_URL);
        ctrl.expectNone(CALL_URL);
        expect(vi.getTimerCount()).toBe(0);
        ctrl.verify();
    });
});
