import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OnboardingGateComponent} from './onboarding-gate.component';
import {NavigationService} from '../../../main-page/navigation.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';

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

async function setup() {
    TestBed.configureTestingModule({
        imports: [OnboardingGateComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const navService = TestBed.inject(NavigationService);
    navService.workspace.set({type: 'server', guild: guildFixture()});

    const fixture: ComponentFixture<OnboardingGateComponent> = TestBed.createComponent(OnboardingGateComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();

    ctrl.expectOne(`${BASE}/guilds/g1/onboarding/me`)
        .flush({completed: false, rulesText: 'Be nice.', defaultChannelIds: []});
    fixture.detectChanges();
    await fixture.whenStable();

    return {fixture, navService, ctrl};
}

describe('OnboardingGateComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('renders the gate modally while onboarding is pending, with no dismiss affordance', async () => {
        const {fixture} = await setup();

        const dialogText = document.body.textContent ?? '';
        expect(dialogText).toContain('ONBOARDING_GATE.RULES_HEADING');
        expect(dialogText).toContain('ONBOARDING_GATE.ACCEPT');
        expect(document.body.querySelector('.p-dialog-close-button')).toBeFalsy();
    });

    it('leaving the server switches the workspace back to DMs, unmounting the gate', async () => {
        const {fixture, navService} = await setup();

        const leaveButton = Array.from(document.body.querySelectorAll('button'))
            .find(btn => btn.textContent?.includes('ONBOARDING_GATE.LEAVE_SERVER'));
        expect(leaveButton).toBeTruthy();

        leaveButton!.click();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(navService.workspace().type).toBe('dms');
    });
});
