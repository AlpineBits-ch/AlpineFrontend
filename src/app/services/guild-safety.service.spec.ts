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

    it('posts an empty body when accepting', () => {
        service.acceptOnboarding('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/accept`);
        expect(req.request.method).toBe('POST');
        req.flush({});
    });
});
