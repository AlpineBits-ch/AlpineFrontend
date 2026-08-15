import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {provideFakePlatform} from '../../platform/testing/provide-fake-platform';
import {InviteDialogComponent} from './invite-dialog.component';
import {InviteDialogService} from './invite-dialog.service';
import {ApiConfigService} from '../../services/api-config.service';
import {InviteDto, InviteState, InviteType} from '../../dtos/response/invite.dto';
import {GuildVerificationLevel} from '../../dtos/response/guild-safety.dto';
import {ChannelType} from '../../dtos/response/guild.dto';
import {VoiceChannelService} from '../../services/voice-channel.service';
import {vi} from 'vitest';

const BASE = 'https://api.test.example/api/v1/guild';

/** Reset per setup, so one test's landing cannot be read by the next. */
let joinChannelSpy = vi.fn();

/** The component keeps its state protected; tests reach it the same way other specs in
 *  this codebase reach protected/private internals - via a narrow structural cast. */
type InternalApi = {
    join(): void;
    load(inviteId?: string | null): void;
    dialogState: () => 'loading' | 'ready' | 'joining' | 'joined' | 'error' | 'blocked' | 'rate-limited';
    requiredLevel: () => string | null;
    blockedReasonKey: () => string;
    isExpired: () => boolean;
    isRevoked: () => boolean;
    joinedTemporarily: () => boolean;
    onboardingRequired: () => boolean;
};

function internal(component: InviteDialogComponent): InternalApi {
    return component as unknown as InternalApi;
}

function inviteFixture(overrides: Partial<InviteDto> = {}): InviteDto {
    return {
        id: 'inv1',
        createdAt: new Date(),
        updatedAt: new Date(),
        type: InviteType.Permanent,
        state: InviteState.Active,
        guildId: 'g1',
        guild: {
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
        },
        code: 'abc123',
        useCount: 0,
        ...overrides,
    };
}

/** The guild the redeem lands us in, with the voice channel the invite targeted. */
function guildWithVoiceChannel() {
    const guild = inviteFixture().guild!;
    return {
        ...guild,
        channels: [{
            id: 'chan_v', createdAt: new Date(), updatedAt: new Date(), name: 'Lounge',
            description: '', type: ChannelType.Voice, guildId: 'g1', isAgeRestricted: false,
            isPrivate: false, categoryId: undefined, permissions: [], position: 0,
            slowModeSeconds: 0, parentChannelId: undefined,
        }],
    };
}

async function setup() {
    joinChannelSpy = vi.fn();
    TestBed.configureTestingModule({
        imports: [InviteDialogComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            // Reached transitively: SocialKeyGateService -> UserService -> MlsService -> MlsEngine.
            // Nothing on the join path encrypts anything, so inert fakes are the whole requirement.
            provideFakePlatform(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // Only reached for a voice-target invite (`joinVoice`), and its real graph drags in the
            // whole RTC stack. A recorder is enough to assert that the landing happened.
            {provide: VoiceChannelService, useValue: {joinChannel: joinChannelSpy}},
        ],
    });

    const inviteDialogService = TestBed.inject(InviteDialogService);
    inviteDialogService.open('inv1');

    const fixture: ComponentFixture<InviteDialogComponent> = TestBed.createComponent(InviteDialogComponent);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();

    return {fixture, component, ctrl, inviteDialogService};
}

async function joinReady(): Promise<Awaited<ReturnType<typeof setup>>> {
    const ctx = await setup();
    ctx.ctrl.expectOne(`${BASE}/invites/inv1`).flush(inviteFixture());
    ctx.fixture.detectChanges();
    await ctx.fixture.whenStable();
    return ctx;
}

describe('InviteDialogComponent join rejection', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('moves to blocked and records the required level on a verification_level_not_met 403', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({error: 'verification_level_not_met', requiredLevel: 'Medium'}, {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('blocked');
        expect(internal(component).requiredLevel()).toBe('Medium');
        expect(internal(component).blockedReasonKey()).toBe('INVITE.VERIFY_MEDIUM');
    });

    it('maps each reported level to its own translation key', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({error: 'verification_level_not_met', requiredLevel: 'High'}, {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).blockedReasonKey()).toBe('INVITE.VERIFY_HIGH');
    });

    it('falls back to the generic key when the server omits requiredLevel', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({error: 'verification_level_not_met'}, {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('blocked');
        expect(internal(component).blockedReasonKey()).toBe('INVITE.VERIFY_GENERIC');
    });

    it('treats an ordinary 403 (no structured body) as a plain refusal, not a block', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush('Forbidden', {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('ready');
        expect(internal(component).requiredLevel()).toBeNull();
    });

    it('resets to ready on a non-403 join error', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush('Server error', {status: 500, statusText: 'Server Error'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('ready');
    });

    it('renders the shield icon, heading, and reason text once blocked, keeping the guild header visible', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({error: 'verification_level_not_met', requiredLevel: 'Low'}, {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        // p-dialog uses appendTo="body", so its content is teleported onto document.body
        // rather than nested under the component's own native element.
        expect(document.body.querySelector('.pi-shield')).toBeTruthy();
        expect(document.body.textContent).toContain('INVITE.CANT_JOIN');
        expect(document.body.textContent).toContain('INVITE.VERIFY_LOW');
        expect(document.body.textContent).toContain('Test Guild');
    });

    it('hides the Join Server action once blocked', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({error: 'verification_level_not_met', requiredLevel: 'Low'}, {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(document.body.textContent).not.toContain('INVITE.JOIN');
    });

    it('resets requiredLevel back to null when a new invite id is opened', async () => {
        const {fixture, component, ctrl, inviteDialogService} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({error: 'verification_level_not_met', requiredLevel: 'High'}, {status: 403, statusText: 'Forbidden'});
        fixture.detectChanges();
        await fixture.whenStable();
        expect(internal(component).requiredLevel()).toBe('High');

        inviteDialogService.open('inv2');
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).requiredLevel()).toBeNull();
        expect(internal(component).dialogState()).toBe('loading');

        ctrl.expectOne(`${BASE}/invites/inv2`).flush(inviteFixture({id: 'inv2'}));
        fixture.detectChanges();
        await fixture.whenStable();
    });
});

describe('InviteDialogComponent preview rate limiting', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('treats a 429 as retryable, never as an invalid invite', async () => {
        const {fixture, component, ctrl} = await setup();

        ctrl.expectOne(`${BASE}/invites/inv1`).flush(
            {error: 'rate_limited', message: 'Too many invite lookups; try again shortly.'},
            {status: 429, statusText: 'Too Many Requests'});
        fixture.detectChanges();
        await fixture.whenStable();

        // The link is very probably fine - the lookup was refused, not the invite. Saying
        // "invalid invite" here tells somebody their working link is broken.
        expect(internal(component).dialogState()).toBe('rate-limited');
        expect(document.body.textContent).toContain('INVITE.RATE_LIMITED_TITLE');
        expect(document.body.textContent).not.toContain('INVITE.INVALID_TITLE');
    });

    it('retries once on demand, and settles when the retry succeeds', async () => {
        const {fixture, component, ctrl} = await setup();

        ctrl.expectOne(`${BASE}/invites/inv1`)
            .flush({error: 'rate_limited'}, {status: 429, statusText: 'Too Many Requests'});
        fixture.detectChanges();
        await fixture.whenStable();

        internal(component).load();
        ctrl.expectOne(`${BASE}/invites/inv1`).flush(inviteFixture());
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('ready');
    });

    it('still reports a genuinely unknown code as invalid', async () => {
        const {fixture, component, ctrl} = await setup();

        ctrl.expectOne(`${BASE}/invites/inv1`).flush(null, {status: 404, statusText: 'Not Found'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('error');
    });
});

describe('InviteDialogComponent invite state', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('reads expiry off the server state rather than the timestamp', async () => {
        const {fixture, component, ctrl} = await setup();

        // Server-derived, and deliberately not re-derived: a lapsed `expiresAt` on an Active row
        // is the server's answer and is rendered as given.
        ctrl.expectOne(`${BASE}/invites/inv1`).flush(inviteFixture({
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }));
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).isExpired()).toBe(false);
    });

    it('renders a revoked invite as revoked, not as expired', async () => {
        const {fixture, component, ctrl} = await setup();

        ctrl.expectOne(`${BASE}/invites/inv1`).flush(inviteFixture({state: InviteState.Revoked}));
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).isRevoked()).toBe(true);
        expect(internal(component).isExpired()).toBe(false);
        expect(document.body.textContent).toContain('INVITE.REVOKED');
        expect(document.body.textContent).not.toContain('INVITE.JOIN');
    });

    it('does not choke on a state value it has never heard of', async () => {
        const {fixture, component, ctrl} = await setup();

        ctrl.expectOne(`${BASE}/invites/inv1`).flush(inviteFixture({state: 'Quarantined' as InviteState}));
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('ready');
        expect(internal(component).isExpired()).toBe(false);
        expect(internal(component).isRevoked()).toBe(false);
        // Still joinable: the server refuses the redeem if it should not happen.
        expect(document.body.textContent).toContain('INVITE.JOIN');
    });
});

describe('InviteDialogComponent redeem result', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('says out loud that the membership is temporary', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({guildId: 'g1', temporaryMembership: true}, {status: 202, statusText: 'Accepted'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).joinedTemporarily()).toBe(true);
        expect(document.body.textContent).toContain('INVITE.TEMPORARY_WARNING');
    });

    it('surfaces a pending rules gate', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`)
            .flush({guildId: 'g1', onboardingRequired: true}, {status: 202, statusText: 'Accepted'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).onboardingRequired()).toBe(true);
        expect(document.body.textContent).toContain('INVITE.ONBOARDING_REQUIRED');
    });

    it('lands in the voice channel when joinVoice says so', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`).flush(
            {guildId: 'g1', channelId: 'chan_v', targetType: 'VoiceChannel', joinVoice: true},
            {status: 202, statusText: 'Accepted'});
        ctrl.expectOne(`${BASE}/guilds/g1`).flush(guildWithVoiceChannel());
        fixture.detectChanges();
        await fixture.whenStable();

        expect(joinChannelSpy).toHaveBeenCalledTimes(1);
        expect(joinChannelSpy.mock.calls[0][0].id).toBe('chan_v');
    });

    it('does not connect when joinVoice is false, even though targetType still says VoiceChannel', async () => {
        const {fixture, component, ctrl} = await joinReady();

        // The channel was deleted or stopped being voice since the link was minted. The guild join
        // still succeeded; only the landing is dropped. Deriving this from targetType would send us
        // at a room that is not there.
        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`).flush(
            {guildId: 'g1', channelId: 'chan_v', targetType: 'VoiceChannel', joinVoice: false},
            {status: 202, statusText: 'Accepted'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(joinChannelSpy).not.toHaveBeenCalled();
    });

    it('still joins the guild when the 202 carries no body at all', async () => {
        const {fixture, component, ctrl} = await joinReady();

        internal(component).join();
        ctrl.expectOne(`${BASE}/invites/inv1/redeem`).flush(null, {status: 202, statusText: 'Accepted'});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(internal(component).dialogState()).toBe('joined');
        expect(joinChannelSpy).not.toHaveBeenCalled();
    });
});
