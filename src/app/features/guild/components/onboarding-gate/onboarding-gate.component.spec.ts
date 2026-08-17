import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OnboardingGateComponent} from './onboarding-gate.component';
import {NavigationService} from '../../../main-page/navigation.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {OnboardingPromptType, OnboardingStatus} from '../../../../dtos/response/guild-safety.dto';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

const BASE = 'https://api.test.example/api/v1/guild';

function guildFixture(): GuildDto {
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
                id: 'chan_1', createdAt: new Date(), updatedAt: new Date(), name: 'welcome',
                description: '', type: ChannelType.Text, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 0,
                slowModeSeconds: 0, parentChannelId: undefined,
            },
        ],
        roles: [],
        systemChannelId: null,
    };
}

function statusFixture(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
    return {
        enabled: true,
        completed: false,
        rulesText: 'Be nice.',
        defaultChannelIds: [],
        prompts: [],
        ...overrides,
    };
}

async function setup(status: OnboardingStatus = statusFixture()) {
    TestBed.configureTestingModule({
        imports: [OnboardingGateComponent],
        providers: [
            provideFakePlatform(),
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // The real store reaches GuildWebsocketService -> AuthService -> OAuthService, none of which this screen needs. Option emoji resolution is the only thing it's used for here, and no fixture exercises a custom emoji.
            {provide: GuildEmojiStore, useValue: {getEmojis: () => [], ensureLoaded: () => undefined}},
        ],
    });

    const navService = TestBed.inject(NavigationService);
    navService.workspace.set({type: 'server', guild: guildFixture()});

    const fixture: ComponentFixture<OnboardingGateComponent> = TestBed.createComponent(OnboardingGateComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();

    ctrl.expectOne(`${BASE}/guilds/g1/onboarding/me`).flush(status);
    fixture.detectChanges();
    await fixture.whenStable();

    return {fixture, navService, ctrl, component: fixture.componentInstance};
}

function textOf(fixture: ComponentFixture<OnboardingGateComponent>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function clickButtonContaining(fixture: ComponentFixture<OnboardingGateComponent>, label: string): void {
    const button = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
        .find(btn => btn.textContent?.includes(label));
    expect(button).toBeTruthy();
    button!.click();
    fixture.detectChanges();
}

describe('OnboardingGateComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('opens on the welcome step with no dismiss affordance', async () => {
        const {fixture} = await setup();

        expect(textOf(fixture)).toContain('ONBOARDING_GATE.WELCOME_TITLE');
        expect((fixture.nativeElement as HTMLElement).querySelector('.p-dialog-close-button')).toBeFalsy();
    });

    it('steps from welcome to the rules', async () => {
        const {fixture} = await setup();

        clickButtonContaining(fixture, 'ONBOARDING_GATE.CONTINUE');

        expect(textOf(fixture)).toContain('ONBOARDING_GATE.RULES_HEADING');
        expect(textOf(fixture)).toContain('Be nice.');
    });

    it('skips the rules step entirely when the guild has none', async () => {
        const {fixture, component} = await setup(statusFixture({
            rulesText: null,
            prompts: [{
                id: 'onbp_1', title: 'Pick one', type: OnboardingPromptType.MultipleChoice,
                singleSelect: true, required: false, inOnboarding: true, position: 0,
                options: [{id: 'onbo_1', title: 'Gaming', roleIds: ['r1'], channelIds: [], position: 0}],
            }],
        }));

        expect(component['steps']().map(s => s.kind)).toEqual(['welcome', 'prompt', 'done']);
        expect(textOf(fixture)).not.toContain('ONBOARDING_GATE.RULES_HEADING');
    });

    /** Mirrors the server's 400 rather than letting the member reach the end and fail there. */
    it('blocks Continue on an unanswered required prompt', async () => {
        const {fixture, component} = await setup(statusFixture({
            rulesText: null,
            prompts: [{
                id: 'onbp_1', title: 'Pick one', type: OnboardingPromptType.MultipleChoice,
                singleSelect: true, required: true, inOnboarding: true, position: 0,
                options: [{id: 'onbo_1', title: 'Gaming', roleIds: ['r1'], channelIds: [], position: 0}],
            }],
        }));

        clickButtonContaining(fixture, 'ONBOARDING_GATE.CONTINUE');
        expect(component['stepIndex']()).toBe(1);

        // Still on the prompt: the required answer is missing.
        clickButtonContaining(fixture, 'ONBOARDING_GATE.CONTINUE');
        expect(component['stepIndex']()).toBe(1);
        expect(component['showRequiredError']()).toBe(true);

        component['onSelectionChange']('onbp_1', ['onbo_1']);
        fixture.detectChanges();
        clickButtonContaining(fixture, 'ONBOARDING_GATE.CONTINUE');
        expect(component['stepIndex']()).toBe(2);
    });

    it('submits the collected answers and re-reads the guild on accept', async () => {
        const {fixture, ctrl, component} = await setup(statusFixture({
            rulesText: null,
            prompts: [{
                id: 'onbp_1', title: 'Pick one', type: OnboardingPromptType.MultipleChoice,
                singleSelect: false, required: false, inOnboarding: true, position: 0,
                options: [{id: 'onbo_1', title: 'Gaming', roleIds: ['r1'], channelIds: [], position: 0}],
            }],
        }));

        component['onSelectionChange']('onbp_1', ['onbo_1']);
        component['stepIndex'].set(2);
        fixture.detectChanges();

        clickButtonContaining(fixture, 'ONBOARDING_GATE.ACCEPT');

        const accept = ctrl.expectOne(`${BASE}/guilds/g1/onboarding/accept`);
        expect(accept.request.method).toBe('POST');
        expect(accept.request.body).toEqual({responses: [{promptId: 'onbp_1', optionIds: ['onbo_1']}]});
        accept.flush(null);

        ctrl.expectOne(`${BASE}/guilds/g1`).flush(guildFixture());
    });

    /** A member who joined while onboarding was on and had it disabled under them keeps completed: false forever; gating on that alone would strand them here. */
    it('renders nothing when the guild has onboarding disabled', async () => {
        const {fixture} = await setup(statusFixture({enabled: false}));

        expect(textOf(fixture).trim()).toBe('');
    });

    it('leaving the server switches the workspace back to DMs, unmounting the wizard', async () => {
        const {fixture, navService} = await setup();

        clickButtonContaining(fixture, 'ONBOARDING_GATE.LEAVE_SERVER');

        expect(navService.workspace().type).toBe('dms');
    });
});
