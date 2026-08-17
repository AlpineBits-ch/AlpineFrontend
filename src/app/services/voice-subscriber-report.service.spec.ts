import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {ApiConfigService} from './api-config.service';
import {WatchScope} from './share-watch.service';
import {TILE_REPORT_DEBOUNCE_MS, VoiceSubscriberReportService} from './voice-subscriber-report.service';

const BASE = 'https://api.test.example';
const CHANNEL_URL = `${BASE}/api/v1/guild/guilds/g1/channels/c1/voice/subscriptions`;
const CALL_URL = `${BASE}/api/v1/messaging/voice/calls/call1/subscriptions`;

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
    return {
        service: TestBed.inject(VoiceSubscriberReportService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

/** Past the trailing debounce, so whatever was going to be sent has been. */
function settle(): void {
    vi.advanceTimersByTime(TILE_REPORT_DEBOUNCE_MS + 1);
}

describe('VoiceSubscriberReportService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('does not report until the sizes stop moving', () => {
        const {service, ctrl} = setup();

        service.report(CHANNEL, 'camera:u1', 'u1', 180);
        service.report(CHANNEL, 'camera:u1', 'u1', 300);
        service.report(CHANNEL, 'camera:u1', 'u1', 720);
        ctrl.expectNone(CHANNEL_URL);

        settle();
        const req = ctrl.expectOne(CHANNEL_URL);
        expect(req.request.method).toBe('POST');
        // One request carrying the last measurement, not three carrying each of them: a window drag
        // fires the observer at frame rate, and every report costs the server a re-plan.
        expect(req.request.body).toEqual({tileHeights: {u1: 720}});
        req.flush({});
        ctrl.verify();
    });

    it('sends tileHeights and nothing else, so pins and pauses are left alone', () => {
        const {service, ctrl} = setup();
        service.report(CHANNEL, 'camera:u1', 'u1', 400);
        settle();

        const req = ctrl.expectOne(CHANNEL_URL);
        expect(Object.keys(req.request.body as object)).toEqual(['tileHeights']);
        req.flush({});
        ctrl.verify();
    });

    it('takes the larger tile when one publisher is on screen twice', () => {
        const {service, ctrl} = setup();
        // A camera seat and a screen share from the same person, in the same grid. The server's map
        // is per publisher, and the contract asks for the largest tile they are drawn in.
        service.report(CHANNEL, 'camera:u1', 'u1', 120);
        service.report(CHANNEL, 'share:s1', 'u1', 640);
        settle();

        const req = ctrl.expectOne(CHANNEL_URL);
        expect(req.request.body).toEqual({tileHeights: {u1: 640}});
        req.flush({});
        ctrl.verify();
    });

    it('sends the complete map on every report, because the server replaces rather than merges', () => {
        const {service, ctrl} = setup();
        service.report(CHANNEL, 'camera:u1', 'u1', 400);
        service.report(CHANNEL, 'camera:u2', 'u2', 400);
        settle();
        ctrl.expectOne(CHANNEL_URL).flush({});

        service.release(CHANNEL, 'camera:u2');
        settle();
        const req = ctrl.expectOne(CHANNEL_URL);
        // u2 is gone by omission. A partial body would leave the server's copy of u2 in place and
        // reading as a measurement nobody is making any more.
        expect(req.request.body).toEqual({tileHeights: {u1: 400}});
        req.flush({});
        ctrl.verify();
    });

    it('ignores a resize too small to change the layer the server would pick', () => {
        const {service, ctrl} = setup();
        service.report(CHANNEL, 'camera:u1', 'u1', 400);
        settle();
        ctrl.expectOne(CHANNEL_URL).flush({});

        service.report(CHANNEL, 'camera:u1', 'u1', 412);
        settle();
        ctrl.expectNone(CHANNEL_URL);

        service.report(CHANNEL, 'camera:u1', 'u1', 160);
        settle();
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.verify();
    });

    it('reports a call on the media route, which is the plural one', () => {
        const {service, ctrl} = setup();
        service.report(CALL, 'share:s1', 'u9', 540);
        settle();

        ctrl.expectOne(CALL_URL).flush({});
        ctrl.verify();
    });

    it('forgets what it sent when the report fails, so the next resize retries', () => {
        const {service, ctrl} = setup();
        service.report(CHANNEL, 'camera:u1', 'u1', 400);
        settle();
        ctrl.expectOne(CHANNEL_URL).flush('nope', {status: 403, statusText: 'Forbidden'});

        // The identical measurement, which would otherwise be deduped against a report that never
        // landed and leave this client permanently un-measured.
        service.report(CHANNEL, 'camera:u1', 'u1', 401);
        settle();
        ctrl.expectOne(CHANNEL_URL).flush({});
        ctrl.verify();
    });

    it('drops a pending report when the room is left', () => {
        const {service, ctrl} = setup();
        service.report(CHANNEL, 'camera:u1', 'u1', 400);
        service.clear(CHANNEL);
        settle();

        ctrl.expectNone(CHANNEL_URL);
        ctrl.verify();
    });

    it('ignores a tile with no box, which is what an unlaid-out element measures as', () => {
        const {service, ctrl} = setup();
        service.report(CHANNEL, 'camera:u1', 'u1', 0);
        settle();

        ctrl.expectNone(CHANNEL_URL);
        ctrl.verify();
    });
});
