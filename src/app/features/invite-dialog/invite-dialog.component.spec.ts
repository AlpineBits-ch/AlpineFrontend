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

const BASE = 'https://api.test.example/api/v1/guild';

/** The component keeps its state protected; tests reach it the same way other specs in
 *  this codebase reach protected/private internals - via a narrow structural cast. */
type InternalApi = {
    join(): void;
    dialogState: () => 'loading' | 'ready' | 'joining' | 'joined' | 'error' | 'blocked';
    requiredLevel: () => string | null;
    blockedReasonKey: () => string;
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

async function setup() {
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
