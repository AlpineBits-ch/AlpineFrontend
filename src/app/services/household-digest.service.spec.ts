import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';
import {afterEach, describe, expect, it} from 'vitest';
import {HouseholdDigestService} from './household-digest.service';
import {HouseholdAlertService} from './household-alert.service';
import {ApiConfigService} from './api-config.service';
import {HouseholdAlert} from '../dtos/response/household-alert.dto';
import {HouseholdDigest} from '../dtos/response/household-digest.dto';

const BASE = 'https://api.test.example';
const URL = `${BASE}/api/v1/guild/guilds/gild_1/home`;

const alerts$ = new Subject<HouseholdAlert>();

function digest(overrides: Partial<HouseholdDigest> = {}): HouseholdDigest {
    return {
        guildId: 'gild_1',
        chores: {mine: [], mineOverdueCount: 0, houseOverdueCount: 2},
        lists: null,
        pantry: null,
        ledger: null,
        decisions: null,
        homeStatus: null,
        ...overrides,
    };
}

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: HouseholdAlertService, useValue: {alerts$}},
        ],
    });
    return {
        service: TestBed.inject(HouseholdDigestService),
        http: TestBed.inject(HttpTestingController),
    };
}

afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
});

describe('HouseholdDigestService', () => {
    it('sends no If-None-Match on the first fetch and keeps the tag it gets back', async () => {
        const {service, http} = setup();

        const load = service.refresh('gild_1');
        const first = http.expectOne(URL);
        expect(first.request.headers.has('If-None-Match')).toBe(false);
        first.flush(digest(), {headers: {ETag: 'W/"abc"'}});
        await load;

        service.invalidate('gild_1');
        // invalidate() drops the tag as well as the timestamp: it means "I can no longer trust
        // what I hold", and revalidating against a tag whose body has been discarded would answer
        // 304 and leave nothing to render.
        const refetch = service.refresh('gild_1');
        const second = http.expectOne(URL);
        expect(second.request.headers.has('If-None-Match')).toBe(false);
        second.flush(digest());
        await refetch;
    });

    it('revalidates with the previous tag and keeps the body a 304 does not carry', async () => {
        const {service, http} = setup();

        const load = service.refresh('gild_1');
        http.expectOne(URL).flush(digest(), {headers: {ETag: 'W/"abc"'}});
        await load;

        const revalidate = service.refresh('gild_1');
        const conditional = http.expectOne(URL);
        expect(conditional.request.headers.get('If-None-Match')).toBe('W/"abc"');
        conditional.flush(null, {status: 304, statusText: 'Not Modified'});
        await revalidate;

        // A 304 is a success with no body. Treating it as one - Angular hands it over as an error -
        // is the whole reason the conditional fetch is worth doing.
        expect(service.stateFor('gild_1').digest?.chores?.houseOverdueCount).toBe(2);
        expect(service.stateFor('gild_1').error).toBe(false);
        expect(service.stateFor('gild_1').loadedAt).toBeGreaterThan(0);
    });

    it('holds a 403 apart from an ordinary failure', async () => {
        const {service, http} = setup();

        const load = service.refresh('gild_1');
        http.expectOne(URL).flush('nope', {status: 403, statusText: 'Forbidden'});
        await load;

        expect(service.stateFor('gild_1').forbidden).toBe(true);
        expect(service.stateFor('gild_1').loadedAt).toBe(0);
    });

    it('keeps the digest it had when a refresh fails', async () => {
        const {service, http} = setup();

        const load = service.refresh('gild_1');
        http.expectOne(URL).flush(digest());
        await load;

        const failed = service.refresh('gild_1');
        http.expectOne(URL).flush('boom', {status: 500, statusText: 'Server Error'});
        await failed;

        expect(service.stateFor('gild_1').digest).not.toBeNull();
        expect(service.stateFor('gild_1').error).toBe(true);
    });

    it('does not re-ask inside the stale window, and does after an invalidate', async () => {
        const {service, http} = setup();

        const load = service.ensureLoaded('gild_1');
        http.expectOne(URL).flush(digest());
        await load;

        await service.ensureLoaded('gild_1');
        http.expectNone(URL);

        service.invalidate('gild_1');
        const again = service.ensureLoaded('gild_1');
        http.expectOne(URL).flush(digest());
        await again;
    });

    it('refetches a loaded house on a household alert, and ignores one for a house it has never drawn', async () => {
        const {service, http} = setup();

        const load = service.refresh('gild_1');
        http.expectOne(URL).flush(digest(), {headers: {ETag: 'W/"abc"'}});
        await load;

        // An alert is the one household event that means "this changed while you were not looking",
        // which is exactly when a glance surface is wrong and has no way to know.
        alerts$.next({
            guildId: 'gild_1',
            channelId: 'chan_1',
            kind: 'chore.due',
            targetId: 'occr_1',
            title: 'Your turn',
            body: 'Bins',
        });
        const conditional = http.expectOne(URL);
        expect(conditional.request.headers.get('If-None-Match')).toBe('W/"abc"');
        conditional.flush(digest());

        alerts$.next({
            guildId: 'gild_other',
            channelId: 'chan_9',
            kind: 'ledger.expense',
            targetId: 'expn_1',
            title: 'New expense',
            body: '40 CHF',
        });
        http.expectNone(`${BASE}/api/v1/guild/guilds/gild_other/home`);
    });
});
