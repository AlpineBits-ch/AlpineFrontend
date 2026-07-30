import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OverviewSettingsComponent} from './overview-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../../../../../../dtos/response/guild-safety.dto';

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
                id: 'chan_1', createdAt: new Date(), updatedAt: new Date(), name: 'general',
                description: '', type: ChannelType.Text, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 0,
                slowModeSeconds: 0, parentChannelId: undefined,
            },
            {
                id: 'chan_2', createdAt: new Date(), updatedAt: new Date(), name: 'voice',
                description: '', type: ChannelType.Voice, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 1,
                slowModeSeconds: 0, parentChannelId: undefined,
            },
        ],
        roles: [],
        systemChannelId: 'chan_1',
        verificationLevel: GuildVerificationLevel.None,
        ...overrides,
    };
}

function setup(guild: GuildDto) {
    TestBed.configureTestingModule({
        imports: [OverviewSettingsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<OverviewSettingsComponent> = TestBed.createComponent(OverviewSettingsComponent);
    fixture.componentRef.setInput('guild', guild);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component, ctrl};
}

describe('OverviewSettingsComponent system channel picker', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('only offers Text channels as options', () => {
        const {component} = setup(guildFixture());
        expect(component.channelOptions()).toEqual([{label: 'general', value: 'chan_1'}]);
    });

    it('initializes systemChannelId from the guild input', () => {
        const {component} = setup(guildFixture());
        expect(component.systemChannelId()).toBe('chan_1');
    });

    it('is not dirty until a field changes', () => {
        const {component} = setup(guildFixture());
        expect(component.dirty()).toBe(false);
    });

    it('marks dirty when systemChannelId changes and includes it in the save payload', () => {
        const {component, ctrl} = setup(guildFixture());
        component.systemChannelId.set('chan_3');
        component.onFieldChange();
        expect(component.dirty()).toBe(true);

        component.save();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'Test Guild', description: '', systemChannelId: 'chan_3'});
        req.flush(guildFixture({systemChannelId: 'chan_3'}));
    });

    it('omits systemChannelId from the save payload when unchanged', () => {
        const {component, ctrl} = setup(guildFixture());
        component.name.set('Renamed');
        component.onFieldChange();

        component.save();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'Renamed', description: ''});
        expect(req.request.body.systemChannelId).toBeUndefined();
        req.flush(guildFixture({name: 'Renamed'}));
    });
});

describe('OverviewSettingsComponent verification level picker', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('initializes verificationLevel from the guild input', () => {
        const {component} = setup(guildFixture({verificationLevel: GuildVerificationLevel.Medium}));
        expect(component.verificationLevel()).toBe(GuildVerificationLevel.Medium);
    });

    it('defaults verificationLevel to None when the guild input omits it', () => {
        const {component} = setup(guildFixture({verificationLevel: undefined}));
        expect(component.verificationLevel()).toBe(GuildVerificationLevel.None);
    });

    it('marks dirty when verificationLevel changes and includes it in the save payload', () => {
        const {component, ctrl} = setup(guildFixture());
        component.verificationLevel.set(GuildVerificationLevel.High);
        component.onFieldChange();
        expect(component.dirty()).toBe(true);

        component.save();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'Test Guild', description: '', verificationLevel: GuildVerificationLevel.High});
        req.flush(guildFixture({verificationLevel: GuildVerificationLevel.High}));
    });

    it('omits verificationLevel from the save payload when unchanged', () => {
        const {component, ctrl} = setup(guildFixture());
        component.name.set('Renamed');
        component.onFieldChange();

        component.save();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body.verificationLevel).toBeUndefined();
        req.flush(guildFixture({name: 'Renamed'}));
    });

    it('renders the matching hint text for the selected level', () => {
        const {fixture, component} = setup(guildFixture());
        expect(fixture.nativeElement.textContent).toContain('GUILD_SETTINGS.OVERVIEW.VERIFY_NONE_HINT');

        component.verificationLevel.set(GuildVerificationLevel.High);
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('GUILD_SETTINGS.OVERVIEW.VERIFY_HIGH_HINT');
    });
});
