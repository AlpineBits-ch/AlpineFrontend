import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {vi} from 'vitest';
import {inviteOrigin, InvitesSettingsComponent, MAX_USES_PRESETS} from './invites-settings.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../../../../../../dtos/response/guild-safety.dto';
import {
    InviteDto,
    InviteState,
    InviteTargetType,
    InviteType,
} from '../../../../../../dtos/response/invite.dto';

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
            {
                id: 'chan_2', createdAt: new Date(), updatedAt: new Date(), name: 'Lounge',
                description: '', type: ChannelType.Voice, guildId: 'g1', isAgeRestricted: false,
                isPrivate: false, categoryId: undefined, permissions: [], position: 1,
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

describe('InvitesSettingsComponent invite state', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('renders the server state and does not re-derive expiry from the timestamp', () => {
        const {component} = setup();
        // The server derives `state` on every read, including the consumed-one-time case nothing
        // here can see. A local `expiresAt < now` check would be a second source of truth that
        // disagrees with it, so a lapsed timestamp on an Active row is *not* treated as expired.
        const lapsed = inviteFixture({
            id: 'i2', expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const expired = inviteFixture({id: 'i3', state: InviteState.Expired});
        component.invites.set([inviteFixture(), lapsed, expired]);

        expect(component.isExpired(lapsed)).toBe(false);
        expect(component.isExpired(expired)).toBe(true);
        expect(component.expiredCount()).toBe(1);

        component.hideExpired.set(true);
        expect(component.visibleInvites().map(i => i.id)).toEqual(['i1', 'i2']);
    });

    it('keeps revoked and expired apart', () => {
        const {component} = setup();
        const revoked = inviteFixture({id: 'i4', state: InviteState.Revoked, revokedAt: new Date().toISOString()});
        const expired = inviteFixture({id: 'i5', state: InviteState.Expired});
        component.invites.set([revoked, expired]);

        expect(component.isRevoked(revoked)).toBe(true);
        expect(component.isExpired(revoked)).toBe(false);
        expect(component.isRevoked(expired)).toBe(false);
        expect(component.copyTooltipKey(revoked)).toBe('GUILD_SETTINGS.INVITES.COPY_REVOKED');
        expect(component.copyTooltipKey(expired)).toBe('GUILD_SETTINGS.INVITES.COPY_EXPIRED');
    });

    it('treats a state it has never heard of as still usable rather than dead', () => {
        const {component} = setup();
        // `Revoked` arrived as a new value on an existing field and the next one will too. A build
        // that refuses to copy a link it cannot classify breaks a link that works.
        const future = inviteFixture({id: 'i6', state: 'Suspended' as InviteState});
        component.invites.set([future]);

        expect(component.isExpired(future)).toBe(false);
        expect(component.isRevoked(future)).toBe(false);
        expect(component.expiredCount()).toBe(0);
        expect(component.copyTooltipKey(future)).toBe('GUILD_SETTINGS.INVITES.COPY_LINK');
    });
});

describe('InvitesSettingsComponent revoke confirmation', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('only revokes after the confirm dialog is acted on', () => {
        const {component, ctrl} = setup();
        const invite = inviteFixture();
        component.invites.set([invite]);

        component.openRevokeDialog(invite);
        expect(component.showRevokeDialog()).toBe(true);
        ctrl.expectNone(`${BASE}/invites/i1`);

        component.revokeInvite(invite);
        const req = ctrl.expectOne(`${BASE}/invites/i1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(inviteFixture({state: InviteState.Revoked}));

        expect(component.showRevokeDialog()).toBe(false);
        expect(component.invites().length).toBe(0);
    });

    it('keeps the revoked row, in its revoked state, in the audit view', () => {
        const {component, ctrl} = setup();
        component.showRevoked.set(true);
        component.invites.set([inviteFixture()]);

        component.revokeInvite(inviteFixture());
        ctrl.expectOne(`${BASE}/invites/i1`)
            .flush(inviteFixture({state: InviteState.Revoked, revokedAt: '2026-08-15T00:00:00Z'}));

        // The row survives server-side - members who joined through it still point at it - so the
        // audit view shows what happened to it rather than losing it.
        expect(component.invites().length).toBe(1);
        expect(component.isRevoked(component.invites()[0])).toBe(true);
    });

    it('asks for the revoked ones only when the audit view is on', () => {
        const {component, ctrl} = setup();

        component.toggleRevokedView();
        ctrl.expectOne(`${BASE}/guilds/g1/invites?includeRevoked=true`).flush([]);

        component.toggleRevokedView();
        ctrl.expectOne(`${BASE}/guilds/g1/invites`).flush([]);
    });
});

describe('InvitesSettingsComponent create options', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('sends maxUses and channelId, which the server has always accepted', () => {
        const {component, ctrl} = setup();
        component.createMaxUses.set(25);
        component.createChannelId.set('chan_1');

        component.createPermanentInvite();

        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        expect(req.request.body.maxUses).toBe(25);
        expect(req.request.body.channelId).toBe('chan_1');
        req.flush(inviteFixture());
    });

    it('omits the optional fields entirely when nothing was chosen', () => {
        const {component, ctrl} = setup();

        component.createPermanentInvite();

        // `{}` is exactly the old behaviour, and 0 is refused with a 400 - so "unlimited" is an
        // absent field, never a zero.
        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        expect(req.request.body.maxUses).toBeUndefined();
        expect(req.request.body.channelId).toBeUndefined();
        expect(req.request.body.temporary).toBeUndefined();
        expect(req.request.body.targetType).toBeUndefined();
        req.flush(inviteFixture());
    });

    it('refuses a voice target with no channel, before the round trip', () => {
        const {component, ctrl} = setup();
        component.createTargetType.set(InviteTargetType.VoiceChannel);

        component.createPermanentInvite();

        expect(component.targetError()).toBe('GUILD_SETTINGS.INVITES.TARGET_NEEDS_CHANNEL');
        ctrl.expectNone(`${BASE}/guilds/g1/invite`);
    });

    it('refuses a voice target pointed at a text channel', () => {
        const {component, ctrl} = setup();
        component.createTargetType.set(InviteTargetType.VoiceChannel);
        component.createChannelId.set('chan_1');

        component.createOneTimeInvite();

        expect(component.targetError()).toBe('GUILD_SETTINGS.INVITES.TARGET_NEEDS_VOICE');
        ctrl.expectNone(`${BASE}/guilds/g1/invite`);
    });

    it('sends a voice target once it names a voice channel', () => {
        const {component, ctrl} = setup();
        component.createTargetType.set(InviteTargetType.VoiceChannel);
        component.createChannelId.set('chan_2');
        component.createTemporary.set(true);

        component.createPermanentInvite();

        expect(component.targetError()).toBeNull();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/invite`);
        expect(req.request.body.targetType).toBe(InviteTargetType.VoiceChannel);
        expect(req.request.body.channelId).toBe('chan_2');
        expect(req.request.body.temporary).toBe(true);
        req.flush(inviteFixture());
    });
});

describe('MAX_USES_PRESETS', () => {
    it('never offers 0, which the server refuses with a 400', () => {
        // An invite exhausted the moment it exists is a link somebody is about to share.
        expect(MAX_USES_PRESETS).not.toContain(0);
        expect(MAX_USES_PRESETS[0]).toBeNull();
        expect(MAX_USES_PRESETS.every(v => v === null || v >= 1)).toBe(true);
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
