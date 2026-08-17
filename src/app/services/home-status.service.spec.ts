import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {HomeStatusService} from './home-status.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {HomeStatusKind, normalizeHomeStatusKind} from '../dtos/response/home-status.dto';

const BASE = 'https://api.test.example';
const URL = `${BASE}/api/v1/guild/guilds/g1/home-status`;

/** Handlers the service registered on the fake hub, so a test can fire an event by name. */
const hubHandlers = new Map<string, (payload: unknown) => void>();

/** Fixed "now" every test reasons from. */
const NOW = Date.parse('2026-08-03T12:00:00Z');

function isoIn(minutes: number): string {
    return new Date(NOW + minutes * 60_000).toISOString();
}

function setup() {
    hubHandlers.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: unknown) => void) =>
                        hubHandlers.set(event, handler),
                },
            },
        ],
    });
    return {
        service: TestBed.inject(HomeStatusService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function fire(payload: unknown): void {
    const handler = hubHandlers.get('guild.HomeStatusChanged');
    if (!handler) throw new Error('guild.HomeStatusChanged was never registered');
    handler(payload);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('HomeStatusService realtime registration', () => {
    it('registers guild.HomeStatusChanged exactly once, in the constructor', () => {
        const registrations: string[] = [];
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
                {
                    provide: RealtimeConnectionService,
                    useValue: {on: (event: string) => registrations.push(event)},
                },
            ],
        });
        TestBed.inject(HomeStatusService);
        // `on` does not deduplicate, so a double registration would apply every event twice.
        TestBed.inject(HomeStatusService);

        expect(registrations).toEqual(['guild.HomeStatusChanged']);
    });
});

describe('HomeStatusService - the two payload shapes under one event name', () => {
    it('applies the {guildId, status} shape as an upsert', () => {
        const {service} = setup();

        fire({
            guildId: 'g1',
            status: {userId: 'u1', kind: 'Asleep', note: 'early start', expiresAt: isoIn(60)},
        });

        expect(service.statuses('g1').map(s => s.userId)).toEqual(['u1']);
        expect(service.statuses('g1')[0].kind).toBe(HomeStatusKind.Asleep);
        expect(service.statuses('g1')[0].note).toBe('early start');
    });

    it('applies the {guildId, userId, cleared} shape as a removal', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Home', note: null, expiresAt: isoIn(60)}});
        expect(service.statuses('g1').length).toBe(1);

        fire({guildId: 'g1', userId: 'u1', cleared: true});

        expect(service.statuses('g1')).toEqual([]);
    });

    it('replaces rather than duplicates when the same user sets a status again', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Out', note: null, expiresAt: isoIn(60)}});
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'OnMyWay', note: null, expiresAt: isoIn(30)}});

        expect(service.statuses('g1').length).toBe(1);
        expect(service.statuses('g1')[0].kind).toBe(HomeStatusKind.OnMyWay);
    });

    it('keeps guilds apart - a clear in one house does not touch the other', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Home', note: null, expiresAt: isoIn(60)}});
        fire({guildId: 'g2', status: {userId: 'u1', kind: 'Home', note: null, expiresAt: isoIn(60)}});

        fire({guildId: 'g1', userId: 'u1', cleared: true});

        expect(service.statuses('g1')).toEqual([]);
        expect(service.statuses('g2').length).toBe(1);
    });

    it('ignores a set with no expiry - an entry that can never decay is the one thing this must not hold', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Home', note: null}});
        expect(service.statuses('g1')).toEqual([]);
    });
});

describe('normalizeHomeStatusKind - the gateway may send the int form', () => {
    it('accepts the string form', () => {
        expect(normalizeHomeStatusKind('DoNotDisturb')).toBe(HomeStatusKind.DoNotDisturb);
    });

    it('accepts the int form, indexed by declaration order', () => {
        expect(normalizeHomeStatusKind(0)).toBe(HomeStatusKind.Home);
        expect(normalizeHomeStatusKind(2)).toBe(HomeStatusKind.Asleep);
        expect(normalizeHomeStatusKind(4)).toBe(HomeStatusKind.OnMyWay);
    });

    it('accepts a numeric string, which is the int form through a lenient serializer', () => {
        expect(normalizeHomeStatusKind('3')).toBe(HomeStatusKind.DoNotDisturb);
    });

    it('returns null for an unknown kind rather than silently defaulting to Home', () => {
        expect(normalizeHomeStatusKind('Gardening')).toBeNull();
        expect(normalizeHomeStatusKind(99)).toBeNull();
        expect(normalizeHomeStatusKind(null)).toBeNull();
    });
});

describe('HomeStatusService decay', () => {
    it('drops an entry once its expiresAt has passed', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Asleep', note: null, expiresAt: isoIn(30)}});
        fire({guildId: 'g1', status: {userId: 'u2', kind: 'Out', note: null, expiresAt: isoIn(600)}});
        expect(service.statuses('g1').length).toBe(2);

        // An hour later u1's assertion has lapsed. A stale board is worse than no board.
        vi.setSystemTime(NOW + 60 * 60_000);
        service['tick']();

        expect(service.statuses('g1').map(s => s.userId)).toEqual(['u2']);
    });

    it('empties the board once everything has expired', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Home', note: null, expiresAt: isoIn(5)}});

        vi.setSystemTime(NOW + 10 * 60_000);
        service['tick']();

        expect(service.statuses('g1')).toEqual([]);
    });

    it('keeps an entry that expires in the future', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'u1', kind: 'Home', note: null, expiresAt: isoIn(12 * 60)}});

        vi.setSystemTime(NOW + 60 * 60_000);
        service['tick']();

        expect(service.statuses('g1').length).toBe(1);
    });

    it('drops an entry the fetch returned that has since expired, without another request', () => {
        const {service, ctrl} = setup();
        const done = service.ensureLoaded('g1');
        ctrl.expectOne(URL).flush([{userId: 'u1', kind: 'Asleep', note: null, expiresAt: isoIn(30)}]);
        return done.then(() => {
            expect(service.statuses('g1').length).toBe(1);
            vi.setSystemTime(NOW + 45 * 60_000);
            service['tick']();
            expect(service.statuses('g1')).toEqual([]);
            ctrl.verify();
        });
    });
});

describe('HomeStatusService module gating', () => {
    it('marks the guild unavailable on a 403 rather than reporting a denial', async () => {
        const {service, ctrl} = setup();
        const done = service.ensureLoaded('g1');
        ctrl.expectOne(URL).flush('forbidden', {status: 403, statusText: 'Forbidden'});
        await done;

        expect(service.isUnavailable('g1')).toBe(true);
        expect(service.statuses('g1')).toEqual([]);
    });

    it('does not retry a guild it already knows is unavailable', async () => {
        const {service, ctrl} = setup();
        const first = service.ensureLoaded('g1');
        ctrl.expectOne(URL).flush('forbidden', {status: 403, statusText: 'Forbidden'});
        await first;

        await service.ensureLoaded('g1');
        ctrl.verify();
    });

    it('lets a transient failure be retried rather than pinning the guild as loaded', async () => {
        const {service, ctrl} = setup();
        const first = service.ensureLoaded('g1');
        ctrl.expectOne(URL).flush('boom', {status: 500, statusText: 'Server Error'});
        await first;

        const second = service.ensureLoaded('g1');
        ctrl.expectOne(URL).flush([]);
        await second;
        ctrl.verify();
    });
});

describe('HomeStatusService own', () => {
    it('finds the caller among the live statuses and ignores an expired one', () => {
        const {service} = setup();
        fire({guildId: 'g1', status: {userId: 'me', kind: 'Home', note: null, expiresAt: isoIn(30)}});
        expect(service.own('g1', 'me')?.kind).toBe(HomeStatusKind.Home);

        vi.setSystemTime(NOW + 60 * 60_000);
        service['tick']();
        expect(service.own('g1', 'me')).toBeNull();
    });

    it('is null with no signed-in user id', () => {
        const {service} = setup();
        expect(service.own('g1', undefined)).toBeNull();
    });
});
