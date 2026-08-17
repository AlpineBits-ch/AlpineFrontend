import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OnboardingSettingsComponent} from './onboarding-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {
    GuildVerificationLevel,
    OnboardingConfig,
    OnboardingMode,
    OnboardingPrompt,
    OnboardingPromptType,
    WelcomeScreen,
} from '../../../../../../dtos/response/guild-safety.dto';

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
        mode: OnboardingMode.Default,
        rulesText: null,
        defaultChannelIds: [],
        prompts: [],
        ...overrides,
    };
}

function promptFixture(overrides: Partial<OnboardingPrompt> = {}): OnboardingPrompt {
    return {
        id: 'onbp_1',
        title: 'What brings you here?',
        type: OnboardingPromptType.MultipleChoice,
        singleSelect: true,
        required: false,
        inOnboarding: true,
        position: 0,
        options: [
            {id: 'onbo_1', title: 'Gaming', description: null, emoji: null, roleIds: ['r1'], channelIds: [], position: 0},
        ],
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

/** ngOnInit fires three independent reads; the welcome screen and pending list are side panels of the same screen and are allowed to fail, so they're flushed empty here rather than asserted on. */
function flushInitialLoad(ctrl: HttpTestingController, cfg: OnboardingConfig = onboardingFixture()) {
    const configReq = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
    expect(configReq.request.method).toBe('GET');
    configReq.flush(cfg);

    ctrl.expectOne(`${BASE}/guilds/g1/welcome-screen`).flush({enabled: false, description: null, channels: []});
    ctrl.expectOne(`${BASE}/guilds/g1/members/pending?limit=100&offset=0`).flush([]);
}

describe('OnboardingSettingsComponent load', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('populates fields from the loaded config', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({
            enabled: true,
            rulesText: 'be nice',
            defaultChannelIds: ['c1'],
            prompts: [promptFixture()],
        }));

        expect(component['enabled']()).toBe(true);
        expect(component['rulesText']()).toBe('be nice');
        expect(component['defaultChannelIds']()).toEqual(['c1']);
        expect(component['prompts']().length).toBe(1);
        expect(component['loading']()).toBe(false);
    });

    it('sorts prompts by position regardless of the order they arrive in', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({
            prompts: [
                promptFixture({id: 'onbp_b', position: 1}),
                promptFixture({id: 'onbp_a', position: 0}),
            ],
        }));

        expect(component['prompts']().map(p => p.id)).toEqual(['onbp_a', 'onbp_b']);
    });
});

describe('OnboardingSettingsComponent save - client-side guard', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('blocks the save when enabled with neither rules text nor an onboarding prompt', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['rulesText'].set('   ');
        component['save']();

        expect(component['validationErrors']()).toContain('GUILD_SETTINGS.ONBOARDING.ERR_NEEDS_CONTENT');
        ctrl.expectNone(`${BASE}/guilds/g1/onboarding`);
    });

    it('allows the save when enabled with a prompt but no rules text', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['prompts'].set([promptFixture()]);
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        expect(req.request.method).toBe('PUT');
        req.flush(req.request.body as OnboardingConfig);
    });

    it('clears the inline error once rules text is entered', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        component['save']();
        expect(component['validationErrors']().length).toBeGreaterThan(0);

        component['rulesText'].set('be nice');
        expect(component['validationErrors']()).toEqual([]);
    });

    it('rejects an option that grants neither a role nor a channel', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['prompts'].set([promptFixture({
            options: [{id: 'onbo_1', title: 'Nothing', description: null, emoji: null, roleIds: [], channelIds: [], position: 0}],
        })]);
        component['save']();

        expect(component['validationErrors']()).toContain('ONBOARDING_EDIT.ERR_OPTION_EMPTY');
        ctrl.expectNone(`${BASE}/guilds/g1/onboarding`);
    });

    it('does not gate the save when disabled, even with blank rules text', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(false);
        component['rulesText'].set('');
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        req.flush(req.request.body as OnboardingConfig);
        expect(component['validationErrors']()).toEqual([]);
    });
});

describe('OnboardingSettingsComponent save - payload', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('sends the whole document, prompts included', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        const prompt = promptFixture();
        component['enabled'].set(true);
        component['rulesText'].set('be nice');
        component['defaultChannelIds'].set(['c1']);
        component['prompts'].set([prompt]);
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({
            enabled: true,
            mode: OnboardingMode.Default,
            rulesText: 'be nice',
            defaultChannelIds: ['c1'],
            prompts: [prompt],
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
            mode: OnboardingMode.Default,
            rulesText: null,
            defaultChannelIds: [],
            prompts: [],
        });
        req.flush(req.request.body as OnboardingConfig);
    });

    /** Generated ids only exist in the response; dropping them re-creates the prompt next save. */
    it('adopts the ids the server assigns to newly created prompts', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['prompts'].set([promptFixture({id: undefined})]);
        component['save']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        req.flush(onboardingFixture({prompts: [promptFixture({id: 'onbp_generated'})]}));

        expect(component['prompts']()[0].id).toBe('onbp_generated');
    });
});

/** Both halves save through their own endpoint but share one dirty flag; a whole welcome screen typed and then thrown away by a nav click, with no prompt, is the failure mode this guards against. */
describe('OnboardingSettingsComponent dirty tracking', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('starts clean once both halves have loaded', () => {
        const {fixture, component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({enabled: true, rulesText: 'be nice'}));
        fixture.detectChanges();

        expect(component['dirty']()).toBe(false);
    });

    it('goes clean again when an edit is undone', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['enabled'].set(true);
        expect(component['dirty']()).toBe(true);

        component['enabled'].set(false);
        expect(component['dirty']()).toBe(false);
    });

    it('reports a prompt reorder and settles on save', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({
            prompts: [promptFixture({id: 'onbp_a', position: 0}), promptFixture({id: 'onbp_b', position: 1})],
        }));

        component['movePrompt'](0, 1);
        expect(component['configDirty']()).toBe(true);

        component['save']();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/onboarding`);
        req.flush(req.request.body as OnboardingConfig);

        expect(component['configDirty']()).toBe(false);
    });

    it('reports a welcome screen edit even while the onboarding half is untouched', () => {
        const {fixture, component, ctrl} = setup();
        const emitted: boolean[] = [];
        component.dirtyChange.subscribe(value => emitted.push(value));
        flushInitialLoad(ctrl);

        component['welcomeDescription'].set('a house for the four of us');
        fixture.detectChanges();

        expect(component['configDirty']()).toBe(false);
        expect(component['welcomeDirty']()).toBe(true);
        expect(emitted.at(-1)).toBe(true);
    });

    it('reports an added and a removed welcome channel', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['addWelcomeChannel']('c1');
        expect(component['welcomeDirty']()).toBe(true);

        component['removeWelcomeChannel'](0);
        expect(component['welcomeDirty']()).toBe(false);
    });

    it('reports an edited welcome channel description', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['addWelcomeChannel']('c1');
        component['saveWelcomeScreen']();
        const added = ctrl.expectOne(`${BASE}/guilds/g1/welcome-screen`);
        added.flush(added.request.body as WelcomeScreen);
        expect(component['welcomeDirty']()).toBe(false);

        component['patchWelcomeChannel'](0, {description: 'say hello here'});
        expect(component['welcomeDirty']()).toBe(true);
    });

    it('clears the welcome half on save without touching the onboarding half', () => {
        const {fixture, component, ctrl} = setup();
        flushInitialLoad(ctrl);

        component['welcomeEnabled'].set(true);
        component['rulesText'].set('be nice');
        component['saveWelcomeScreen']();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/welcome-screen`);
        expect(req.request.method).toBe('PUT');
        req.flush(req.request.body as WelcomeScreen);
        fixture.detectChanges();

        expect(component['welcomeDirty']()).toBe(false);
        expect(component['configDirty']()).toBe(true);
        expect(component['dirty']()).toBe(true);
    });
});

describe('OnboardingSettingsComponent prompt removal', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('keeps the question until the confirmation is accepted', () => {
        const {component, ctrl} = setup();
        flushInitialLoad(ctrl, onboardingFixture({prompts: [promptFixture()]}));

        component['askRemovePrompt'](0);
        expect(component['prompts']().length).toBe(1);
        expect(component['showRemovePrompt']()).toBe(true);

        component['removePrompt']();
        expect(component['prompts']()).toEqual([]);
        expect(component['showRemovePrompt']()).toBe(false);
    });
});
