import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';

import {GuildOnboardingStateService} from './guild-onboarding-state.service';
import {ApiConfigService} from './api-config.service';

describe('GuildOnboardingStateService', () => {
    let service: GuildOnboardingStateService;
    let http: HttpTestingController;
    const url = 'https://api.test.example/api/v1/guild/guilds/g1/onboarding/me';
    const acceptUrl = 'https://api.test.example/api/v1/guild/guilds/g1/onboarding/accept';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                provideTranslateService({defaultLanguage: 'en'}),
                MessageService,
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(GuildOnboardingStateService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('reports a guild as pending when the member has not accepted', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: false, rulesText: 'rules', defaultChannelIds: []});
        expect(service.pendingForGuild('g1')).toBe(true);
    });

    it('does not report a guild as pending once accepted', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: true, rulesText: null, defaultChannelIds: []});
        expect(service.pendingForGuild('g1')).toBe(false);
    });

    it('treats a load failure as not-pending so a transient error cannot lock the UI', () => {
        service.loadFor('g1');
        http.expectOne(url).flush('nope', {status: 500, statusText: 'Server Error'});
        expect(service.pendingForGuild('g1')).toBe(false);
    });

    it('only fetches once per guild', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: false, rulesText: 'r', defaultChannelIds: []});
        service.loadFor('g1');
        http.expectNone(url);
    });

    it('leaves the guild pending when accept fails, so the user can retry', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: false, rulesText: 'rules', defaultChannelIds: []});

        service.accept('g1');
        http.expectOne(acceptUrl).flush('nope', {status: 500, statusText: 'Server Error'});

        expect(service.pendingForGuild('g1')).toBe(true);
    });
});
