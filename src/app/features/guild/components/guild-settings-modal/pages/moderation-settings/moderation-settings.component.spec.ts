import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {ModerationSettingsComponent} from './moderation-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AutoModConfig, GuildVerificationLevel} from '../../../../../../dtos/response/guild-safety.dto';

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
        channels: [],
        roles: [],
        systemChannelId: null,
        verificationLevel: GuildVerificationLevel.None,
        ...overrides,
    };
}

function autoModFixture(overrides: Partial<AutoModConfig> = {}): AutoModConfig {
    return {
        enabled: false,
        blockedWords: [],
        maxMessagesPerInterval: null,
        intervalSeconds: null,
        ...overrides,
    };
}

function setup(guild: GuildDto = guildFixture()) {
    TestBed.configureTestingModule({
        imports: [ModerationSettingsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<ModerationSettingsComponent> =
        TestBed.createComponent(ModerationSettingsComponent);
    fixture.componentRef.setInput('guild', guild);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component, ctrl};
}

function flushInitialLoad(ctrl: HttpTestingController, cfg: AutoModConfig = autoModFixture()) {
    const req = ctrl.expectOne(`${BASE}/guilds/g1/automod`);
    expect(req.request.method).toBe('GET');
    req.flush(cfg);
}

describe('ModerationSettingsComponent load', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('derives rateLimitOn as true only when both rate fields are present', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, autoModFixture({maxMessagesPerInterval: 5, intervalSeconds: 10}));
        expect(component['rateLimitOn']()).toBe(true);
        expect(component['maxMessages']()).toBe(5);
        expect(component['intervalSeconds']()).toBe(10);
    });

    it('derives rateLimitOn as false when only one rate field is present', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, autoModFixture({maxMessagesPerInterval: 5, intervalSeconds: null}));
        expect(component['rateLimitOn']()).toBe(false);
    });

    it('derives rateLimitOn as false when both rate fields are absent', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, autoModFixture());
        expect(component['rateLimitOn']()).toBe(false);
    });
});

describe('ModerationSettingsComponent addWord', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('ignores a blank/whitespace-only draft', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['wordDraft'].set('   ');
        component['addWord']();
        expect(component['blockedWords']()).toEqual([]);
    });

    it('adds a trimmed word and clears the draft', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['wordDraft'].set('  spam  ');
        component['addWord']();
        expect(component['blockedWords']()).toEqual(['spam']);
        expect(component['wordDraft']()).toBe('');
    });

    it('rejects a case-insensitive duplicate without adding it twice', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, autoModFixture({blockedWords: ['spam']}));

        component['wordDraft'].set('Spam');
        component['addWord']();
        expect(component['blockedWords']()).toEqual(['spam']);
        expect(component['wordDraft']()).toBe('');
    });
});

describe('ModerationSettingsComponent removeWord', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('removes only the matching word', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, autoModFixture({blockedWords: ['spam', 'scam']}));

        component['removeWord']('spam');
        expect(component['blockedWords']()).toEqual(['scam']);
    });
});

describe('ModerationSettingsComponent save - rate limit both-or-neither payload', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('blocks the save when the rate limit is on but a field is missing, without sending a request', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['rateLimitOn'].set(true);
        component['maxMessages'].set(5);
        component['intervalSeconds'].set(null);
        component['save']();

        ctrl.expectNone(`${BASE}/guilds/g1/automod`);
    });

    it('sends both rate fields when the toggle is on and both are set', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['blockedWords'].set(['spam']);
        component['rateLimitOn'].set(true);
        component['maxMessages'].set(5);
        component['intervalSeconds'].set(10);
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/automod`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({
            enabled: true,
            blockedWords: ['spam'],
            maxMessagesPerInterval: 5,
            intervalSeconds: 10,
        });
        req.flush(req.request.body as AutoModConfig);
    });

    it('sends null for both rate fields when the toggle is off, even if stale numbers remain', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, autoModFixture({maxMessagesPerInterval: 5, intervalSeconds: 10}));

        component['rateLimitOn'].set(false);
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/automod`);
        expect(req.request.body).toEqual({
            enabled: false,
            blockedWords: [],
            maxMessagesPerInterval: null,
            intervalSeconds: null,
        });
        req.flush(req.request.body as AutoModConfig);
    });
});
