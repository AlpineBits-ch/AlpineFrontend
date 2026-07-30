import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OnboardingSettingsComponent} from './onboarding-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildVerificationLevel, OnboardingConfig} from '../../../../../../dtos/response/guild-safety.dto';

const BASE = 'https://api.test.example/api/v1/guild';

function guildFixture(overrides: Partial<GuildDto> = {}): GuildDto {
    return {
        id: 'g1',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'Test Guild',
        description: '',
        ownerId: 'owner_1',
        categories: [],
        channels: [
            {
                id: 'c1',
                createdAt: new Date(),
                updatedAt: new Date(),
                name: 'general',
                description: '',
                type: ChannelType.Text,
                guildId: 'g1',
                isAgeRestricted: false,
                isPrivate: false,
                categoryId: undefined,
                permissions: [],
                position: 0,
                slowModeSeconds: 0,
                parentChannelId: undefined,
            },
        ],
        roles: [],
        systemChannelId: null,
        verificationLevel: GuildVerificationLevel.None,
        ...overrides,
    };
}

function onboardingFixture(overrides: Partial<OnboardingConfig> = {}): OnboardingConfig {
    return {
        enabled: false,
        rulesText: null,
        defaultChannelIds: [],
        ...overrides,
    };
}

function setup(guild: GuildDto = guildFixture()) {
    TestBed.configureTestingModule({
        imports: [OnboardingSettingsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<OnboardingSettingsComponent> = TestBed.createComponent(OnboardingSettingsComponent);
    fixture.componentRef.setInput('guild', guild);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component, ctrl};
}

function flushInitialLoad(ctrl: HttpTestingController, cfg: OnboardingConfig = onboardingFixture()) {
    const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
    expect(req.request.method).toBe('GET');
    req.flush(cfg);
}

describe('OnboardingSettingsComponent load', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('populates fields from the loaded config', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({enabled: true, rulesText: 'be nice', defaultChannelIds: ['c1']}));

        expect(component['enabled']()).toBe(true);
        expect(component['rulesText']()).toBe('be nice');
        expect(component['defaultChannelIds']()).toEqual(['c1']);
        expect(component['loading']()).toBe(false);
    });
});

describe('OnboardingSettingsComponent save - client-side guard', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('blocks the save and flags the inline error when enabled with blank rules text', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['rulesText'].set('   ');
        component['save']();

        expect(component['rulesRequiredError']()).toBe(true);
        ctrl.expectNone(`${BASE}/guilds/g1/onboarding`);
    });

    it('clears the inline error once rules text is entered', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['save']();
        expect(component['rulesRequiredError']()).toBe(true);

        component['onRulesTextChange']('be nice');
        expect(component['rulesRequiredError']()).toBe(false);
    });

    it('does not gate the save when disabled, even with blank rules text', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(false);
        component['rulesText'].set('');
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        req.flush(req.request.body as OnboardingConfig);
        expect(component['rulesRequiredError']()).toBe(false);
    });
});

describe('OnboardingSettingsComponent save - payload', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('sends the trimmed-checked rules text and selected channels', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['rulesText'].set('be nice');
        component['defaultChannelIds'].set(['c1']);
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({
            enabled: true,
            rulesText: 'be nice',
            defaultChannelIds: ['c1'],
        });
        req.flush(req.request.body as OnboardingConfig);
    });

    it('sends null rules text when blank and disabled', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({rulesText: 'stale'}));

        component['enabled'].set(false);
        component['rulesText'].set('');
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        expect(req.request.body).toEqual({
            enabled: false,
            rulesText: null,
            defaultChannelIds: [],
        });
        req.flush(req.request.body as OnboardingConfig);
    });
});
