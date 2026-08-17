import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {GuildSafetyService} from './guild-safety.service';
import {ApiConfigService} from './api-config.service';

describe('GuildSafetyService', () => {
    let service: GuildSafetyService;
    let http: HttpTestingController;
    const base = 'https://api.test.example/api/v1/guild';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(GuildSafetyService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('PUTs the full auto-mod config', () => {
        const cfg = {enabled: true, blockedWords: ['a'], maxMessagesPerInterval: 5, intervalSeconds: 10};
        service.updateAutoModConfig('g1', cfg).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/automod`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual(cfg);
        req.flush(cfg);
    });

    it('reads the current member onboarding status', () => {
        service.getMyOnboarding('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/me`);
        expect(req.request.method).toBe('GET');
        req.flush({completed: false, rulesText: 'be nice', defaultChannelIds: []});
    });

    /** An entirely empty body is rejected by the model binder before the endpoint runs. */
    it('always posts a JSON body when accepting, even with no prompts', () => {
        service.acceptOnboarding('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/accept`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({responses: []});
        req.flush({});
    });

    it('carries prompt responses through accept', () => {
        service.acceptOnboarding('g1', [{promptId: 'onbp_1', optionIds: ['onbo_1', 'onbo_2']}]).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/accept`);
        expect(req.request.body).toEqual({
            responses: [{promptId: 'onbp_1', optionIds: ['onbo_1', 'onbo_2']}],
        });
        req.flush({});
    });

    it('reads every prompt with the member picks marked', () => {
        service.getMyPrompts('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/prompts`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('PUTs the complete response set, not a delta', () => {
        const responses = [{promptId: 'onbp_1', optionIds: []}];
        service.setMyResponses('g1', responses).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/me/responses`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({responses});
        req.flush(null);
    });

    it('reads and writes the welcome screen', () => {
        service.getWelcomeScreen('g1').subscribe();
        http.expectOne(`${base}/guilds/g1/welcome-screen`).flush({enabled: false, channels: []});

        const screen = {enabled: true, description: 'hi', channels: []};
        service.updateWelcomeScreen('g1', screen).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/welcome-screen`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual(screen);
        req.flush(screen);
    });

    it('pages the pending-member list', () => {
        service.getPendingMembers('g1', 50, 100).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/members/pending?limit=50&offset=100`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });
});
