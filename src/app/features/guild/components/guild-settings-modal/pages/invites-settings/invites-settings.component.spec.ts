import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {InvitesSettingsComponent} from './invites-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../../../../../../dtos/response/guild-safety.dto';
import {InviteState, InviteType} from '../../../../../../dtos/response/invite.dto';

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
                id: 'chan_1', createdAt: new Date(), updatedAt: new Date(), name: 'general',
                description: '', type: ChannelType.Text, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 0,
                slowModeSeconds: 0, parentChannelId: undefined,
            },
        ],
        roles: [],
        systemChannelId: 'chan_1',
        verificationLevel: GuildVerificationLevel.None,
    };
}

function setup() {
    TestBed.configureTestingModule({
        imports: [InvitesSettingsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<InvitesSettingsComponent> = TestBed.createComponent(InvitesSettingsComponent);
    fixture.componentRef.setInput('guild', guildFixture());
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    // ngOnInit loads the existing invites; settle that before each assertion.
    ctrl.expectOne(`${BASE}/guilds/g1/invites`).flush([]);
    return {fixture, component, ctrl};
}

describe('InvitesSettingsComponent expiry handling', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('treats an empty expiry as never expiring', () => {
        const {component, ctrl} = setup();
        component.createExpiryHours.set(null);

        component.createPermanentInvite();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        expect(req.request.body.expiresAt).toBeUndefined();
        req.flush({});
    });

    it('does not silently create a never-expiring invite when 0 hours is entered', () => {
        const {component, ctrl} = setup();
        component.createExpiryHours.set(0);

        component.createOneTimeInvite();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        // 0 is not a usable lifetime, so it must not fall through to "permanent".
        expect(req.request.body.expiresAt).toBeUndefined();
        req.flush({});
    });

    it('sends an expiry timestamp for a positive hour count', () => {
        const {component, ctrl} = setup();
        component.createExpiryHours.set(3);

        component.createPermanentInvite();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        const expiresAt = new Date(req.request.body.expiresAt as string).getTime();
        const expected = Date.now() + 3 * 3600_000;
        expect(Math.abs(expiresAt - expected)).toBeLessThan(5000);
        req.flush({});
    });
});

describe('InvitesSettingsComponent create button state', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('tracks which invite type is in flight so only that button spins', () => {
        const {component, ctrl} = setup();

        component.createOneTimeInvite();
        expect(component.creatingType()).toBe(InviteType.OneTime);

        ctrl.expectOne(`${BASE}/guilds/g1/invite`).flush({
            id: 'i1', createdAt: new Date(), updatedAt: new Date(), type: InviteType.OneTime,
            state: InviteState.Active, guildId: 'g1', code: 'abc', useCount: 0,
        });

        expect(component.creatingType()).toBeNull();
        expect(component.invites().length).toBe(1);
    });
});

describe('InvitesSettingsComponent revoke confirmation', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('only deletes after the confirm dialog is acted on', () => {
        const {component, ctrl} = setup();
        const invite = {
            id: 'i1', createdAt: new Date(), updatedAt: new Date(), type: InviteType.Permanent,
            state: InviteState.Active, guildId: 'g1', code: 'abc', useCount: 0,
        };
        component.invites.set([invite]);

        component.openRevokeDialog(invite);
        expect(component.showRevokeDialog()).toBe(true);
        ctrl.expectNone(`${BASE}/invites/i1`);

        component.revokeInvite(invite);
        ctrl.expectOne(`${BASE}/invites/i1`).flush(null);

        expect(component.showRevokeDialog()).toBe(false);
        expect(component.invites().length).toBe(0);
    });
});
