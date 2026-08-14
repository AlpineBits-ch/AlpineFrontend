import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {vi} from 'vitest';
import {inviteOrigin, InvitesSettingsComponent} from './invites-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../../../../../../dtos/response/guild-safety.dto';
import {InviteDto, InviteState, InviteType} from '../../../../../../dtos/response/invite.dto';

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

function inviteFixture(overrides: Partial<InviteDto> = {}): InviteDto {
    return {
        id: 'i1', createdAt: new Date(), updatedAt: new Date(), type: InviteType.Permanent,
        state: InviteState.Active, guildId: 'g1', code: 'abc', useCount: 0, ...overrides,
    };
}

/** Replaces `navigator.clipboard`, which the test DOM does not provide. */
function stubClipboard(writeText: () => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    return () => Object.defineProperty(navigator, 'clipboard', original ?? {value: undefined, configurable: true});
}

/** Lets the clipboard promise and its handlers settle. */
function settle(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
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
        component.selectExpiryPreset('never');

        component.createPermanentInvite();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        expect(req.request.body.expiresAt).toBeUndefined();
        req.flush({});
    });

    it('refuses 0 hours instead of quietly minting a permanent link', () => {
        const {component, ctrl} = setup();
        component.selectExpiryPreset('custom');
        component.createExpiryHours.set(0);

        component.createOneTimeInvite();

        // 0 is not a usable lifetime. It used to fall through to "permanent"; now the create
        // is blocked outright and the form says why.
        expect(component.expiryError()).toBe('GUILD_SETTINGS.INVITES.EXPIRY_INVALID');
        expect(component.creatingType()).toBeNull();
        ctrl.expectNone(`${BASE}/guilds/g1/invite`);
    });

    it('sends an expiry timestamp for a positive hour count', () => {
        const {component, ctrl} = setup();
        component.selectExpiryPreset('custom');
        component.createExpiryHours.set(3);

        component.createPermanentInvite();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        const expiresAt = new Date(req.request.body.expiresAt as string).getTime();
        const expected = Date.now() + 3 * 3600_000;
        expect(Math.abs(expiresAt - expected)).toBeLessThan(5000);
        req.flush({});
    });

    it('turns a preset into hours without any arithmetic from the user', () => {
        const {component} = setup();

        component.selectExpiryPreset('30m');
        expect(component.createExpiryHours()).toBe(0.5);

        component.selectExpiryPreset('7d');
        expect(component.createExpiryHours()).toBe(168);

        component.selectExpiryPreset('never');
        expect(component.createExpiryHours()).toBeNull();
        expect(component.expiryError()).toBeNull();
    });
});

describe('InvitesSettingsComponent create button state', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('tracks which invite type is in flight so only that button spins', () => {
        const {component, ctrl} = setup();

        component.createOneTimeInvite();
        expect(component.creatingType()).toBe(InviteType.OneTime);

        ctrl.expectOne(`${BASE}/guilds/g1/invite`).flush(inviteFixture({type: InviteType.OneTime}));

        expect(component.creatingType()).toBeNull();
        expect(component.invites().length).toBe(1);
    });
});

describe('InvitesSettingsComponent copying', () => {
    let restoreClipboard: (() => void) | undefined;

    afterEach(() => {
        restoreClipboard?.();
        TestBed.inject(HttpTestingController).verify();
    });

    it('hands the new link straight to the clipboard and marks the row', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        restoreClipboard = stubClipboard(writeText);
        const {component, ctrl} = setup();

        component.createPermanentInvite();
        ctrl.expectOne(`${BASE}/guilds/g1/invite`).flush(inviteFixture({id: 'i9', code: 'xyz'}));

        expect(writeText).toHaveBeenCalledWith('https://test.example/invite/xyz');
        expect(component.highlightId()).toBe('i9');
        await settle();
        expect(component.copiedId()).toBe('i9');
    });

    it('survives a refused clipboard write on creation', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));
        restoreClipboard = stubClipboard(writeText);
        const {component, ctrl} = setup();

        component.createOneTimeInvite();
        ctrl.expectOne(`${BASE}/guilds/g1/invite`).flush(inviteFixture({id: 'i9'}));

        await settle();
        // The invite still exists, it just isn't on the clipboard.
        expect(component.invites().length).toBe(1);
        expect(component.copiedId()).toBeNull();
    });

    it('does not copy an expired invite', () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        restoreClipboard = stubClipboard(writeText);
        const {component} = setup();
        const expired = inviteFixture({state: InviteState.Expired});
        component.invites.set([expired]);

        component.copyInvite(expired);

        expect(writeText).not.toHaveBeenCalled();
        expect(component.copyTooltipKey(expired)).toBe('GUILD_SETTINGS.INVITES.COPY_EXPIRED');
    });
});

describe('InvitesSettingsComponent expired invites', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('counts a lapsed timestamp as expired even while the server still says active', () => {
        const {component} = setup();
        const lapsed = inviteFixture({id: 'i2', expiresAt: new Date(Date.now() - 60_000).toISOString()});
        component.invites.set([inviteFixture(), lapsed]);

        expect(component.isExpired(lapsed)).toBe(true);
        expect(component.expiredCount()).toBe(1);

        component.hideExpired.set(true);
        expect(component.visibleInvites().map(i => i.id)).toEqual(['i1']);
    });
});

describe('InvitesSettingsComponent revoke confirmation', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('only deletes after the confirm dialog is acted on', () => {
        const {component, ctrl} = setup();
        const invite = inviteFixture();
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

describe('inviteOrigin', () => {
    it('drops the api label so a link points at the site, not the API', () => {
        expect(inviteOrigin('https://api.venta.gg')).toBe('https://venta.gg');
    });

    it('leaves a self-hosted host, a bare name and a port alone', () => {
        expect(inviteOrigin('https://chat.example.com')).toBe('https://chat.example.com');
        expect(inviteOrigin('http://localhost:5000')).toBe('http://localhost:5000');
    });

    it('hands back an unparseable value rather than throwing inside a template', () => {
        expect(inviteOrigin('not a url')).toBe('not a url');
    });
});
