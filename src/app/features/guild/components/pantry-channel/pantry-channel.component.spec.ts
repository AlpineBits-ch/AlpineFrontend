import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';
import {PantryChannelComponent} from './pantry-channel.component';
import {ApiConfigService} from '../../../../services/api-config.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';
import {ChannelDto, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {PantryConfig, PantryItem} from '../../../../dtos/response/pantry.dto';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

const BASE = 'https://api.test.example';
const GUILD_URL = `${BASE}/api/v1/guild`;
const GUILD_ID = 'gild_1';
const CHANNEL_ID = 'chan_pantry';
const OWNER_ID = 'user_owner';

/** The whole component surface a test pokes at. Everything on it is `protected`. */
type Internals = {
    canManage(): boolean;
    moduleOff(): boolean;
    restockLoopOn(): boolean;
    listChannelOptions(): { label: string; value: string }[];
    warningDays(): number;
    cfgWarningDays: { set(v: number | null): void };
    cfgWarningDaysValid(): boolean;
    cfgListChannelId: { set(v: string | null): void; (): string | null };
    draftTrackRestock: { set(v: boolean): void; (): boolean };
    draftThreshold: { set(v: number | null): void; (): number | null };
    draftExpiresAt: { set(v: Date | null): void; (): Date | null };
    draftName: { set(v: string): void };
    draftQuantity: { set(v: number | null): void };
    draftUnit: { set(v: string): void };
    openAdd(): void;
    openEdit(item: PantryItem): void;
    openConfig(): void;
    saveItem(): void;
    saveConfig(): void;
    rows(): { item: PantryItem; state: string; expiry: string }[];
};

function channel(): ChannelDto {
    return {id: CHANNEL_ID, guildId: GUILD_ID, name: 'pantry', type: ChannelType.Pantry} as ChannelDto;
}

function guild(overrides: Partial<GuildDto> = {}): GuildDto {
    return {
        id: GUILD_ID,
        name: 'Home',
        ownerId: OWNER_ID,
        features: 'Lists, Pantry',
        channels: [
            channel(),
            {id: 'chan_list', guildId: GUILD_ID, name: 'groceries', type: ChannelType.List} as ChannelDto,
            {id: 'chan_text', guildId: GUILD_ID, name: 'general', type: ChannelType.Text} as ChannelDto,
        ],
        ...overrides,
    } as GuildDto;
}

function member(permissions: string): SelfGuildMemberDto {
    return {permissions, roleMembers: []} as unknown as SelfGuildMemberDto;
}

function item(overrides: Partial<PantryItem> = {}): PantryItem {
    return {
        id: 'pitm_1',
        channelId: CHANNEL_ID,
        name: 'Milk',
        quantity: 4,
        unit: 'l',
        lowThreshold: 2,
        expiresAt: null,
        isLow: false,
        restockedAt: null,
        addedByUserId: 'user_1',
        ...overrides,
    };
}

function setup(opts: {
    guild?: GuildDto;
    member?: SelfGuildMemberDto;
    ownUserId?: string;
    items?: PantryItem[];
    config?: PantryConfig | null;
} = {}) {
    const guildDto = opts.guild ?? guild();

    TestBed.configureTestingModule({
        imports: [PantryChannelComponent],
        providers: [
            provideFakePlatform(),
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: RealtimeConnectionService, useValue: {on: () => undefined, off: () => undefined}},
            {
                provide: GuildService,
                useValue: {
                    guilds: signal<readonly GuildDto[]>([guildDto]),
                    getOwnMember: () => of(opts.member ?? member('ViewChannel')),
                },
            },
            {
                provide: ProfileService,
                useValue: {ownProfile: signal({userId: opts.ownUserId ?? 'user_someone'})},
            },
        ],
    });

    const fixture: ComponentFixture<PantryChannelComponent> = TestBed.createComponent(PantryChannelComponent);
    fixture.componentRef.setInput('channel', channel());
    fixture.detectChanges();

    const ctrl = TestBed.inject(HttpTestingController);
    ctrl.expectOne(`${GUILD_URL}/channels/${CHANNEL_ID}/pantry-items`).flush(opts.items ?? []);
    const configReq = ctrl.expectOne(`${GUILD_URL}/channels/${CHANNEL_ID}/pantry/config`);
    if (opts.config === null) {
        configReq.flush('nope', {status: 404, statusText: 'Not Found'});
    } else {
        configReq.flush(opts.config ?? {
            channelId: CHANNEL_ID, restockListChannelId: 'chan_list', expiryWarningDays: 3,
        });
    }
    fixture.detectChanges();

    return {fixture, ctrl, api: fixture.componentInstance as unknown as Internals};
}

describe('PantryChannelComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('permissions', () => {
        it('withholds the write affordances without ManagePantry - ViewChannel only reads', () => {
            const {api} = setup({member: member('ViewChannel')});
            expect(api.canManage()).toBe(false);
        });

        it('grants them with ManagePantry', () => {
            const {api} = setup({member: member('ViewChannel, ManagePantry')});
            expect(api.canManage()).toBe(true);
        });

        it('grants them to the owner, whose own permission string may not carry Superadmin', () => {
            const {api} = setup({member: member('ViewChannel'), ownUserId: OWNER_ID});
            expect(api.canManage()).toBe(true);
        });
    });

    describe('the module gate', () => {
        it('reports the module off when the guild lacks the Pantry flag', () => {
            const {api} = setup({guild: guild({features: 'Lists'})});
            expect(api.moduleOff()).toBe(true);
        });

        it('does not report it off for a guild that has it', () => {
            const {api} = setup();
            expect(api.moduleOff()).toBe(false);
        });
    });

    describe('the restock list picker', () => {
        it('offers only List channels of this guild', () => {
            const {api} = setup();
            expect(api.listChannelOptions()).toEqual([{label: 'groceries', value: 'chan_list'}]);
        });

        it('offers nothing when the house has no list', () => {
            const {api} = setup({
                guild: guild({channels: [channel()]}),
                config: {channelId: CHANNEL_ID, restockListChannelId: null, expiryWarningDays: 3},
            });
            expect(api.listChannelOptions()).toEqual([]);
        });
    });

    describe('the loop master switch', () => {
        it('is on with a list channel configured', () => {
            const {api} = setup();
            expect(api.restockLoopOn()).toBe(true);
        });

        it('is off with none, whatever the items\' thresholds say', () => {
            const {api} = setup({
                config: {channelId: CHANNEL_ID, restockListChannelId: null, expiryWarningDays: 3},
                items: [item({lowThreshold: 2, quantity: 1})],
            });
            expect(api.restockLoopOn()).toBe(false);
            // The row is still honestly low - it just cannot be appended anywhere, which is
            // what the banner and the struck-through threshold say.
            expect(api.rows()[0].state).toBe('low');
        });
    });

    describe('the item editor and the null-vs-zero threshold', () => {
        it('reopens a 0 threshold as tracked, not as off', () => {
            const {api} = setup({member: member('ManagePantry')});
            api.openEdit(item({lowThreshold: 0}));
            expect(api.draftTrackRestock()).toBe(true);
            expect(api.draftThreshold()).toBe(0);
        });

        it('reopens a null threshold as off', () => {
            const {api} = setup({member: member('ManagePantry')});
            api.openEdit(item({lowThreshold: null}));
            expect(api.draftTrackRestock()).toBe(false);
        });

        // The four regressions below all share one failure mode: the request succeeds, the toast
        // says saved, and the server changed nothing - because a nullable field sent as `null`
        // reads as "leave alone" on the wire. Each asserts the whole body, not one key, so a
        // stray `lowThreshold: null` alongside the flag would fail too.

        it('sends clearLowThreshold - never a null - when tracking is switched off', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openEdit(item({lowThreshold: 2}));
            api.draftTrackRestock.set(false);
            api.saveItem();

            const req = ctrl.expectOne(`${GUILD_URL}/pantry-items/pitm_1`);
            expect(req.request.body).toEqual({
                name: 'Milk', quantity: 4, unit: 'l', clearLowThreshold: true, clearExpiresAt: true,
            });
            req.flush(item({lowThreshold: null}));
        });

        it('sends 0 as a threshold, not as a clear - 0 means "chase it when it runs out"', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openEdit(item({lowThreshold: 2}));
            api.draftThreshold.set(0);
            api.saveItem();

            const req = ctrl.expectOne(`${GUILD_URL}/pantry-items/pitm_1`);
            expect(req.request.body.lowThreshold).toBe(0);
            expect(req.request.body.clearLowThreshold).toBeUndefined();
            req.flush(item({lowThreshold: 0}));
        });

        it('sends clearExpiresAt when the date is removed', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openEdit(item({expiresAt: '2026-08-10T00:00:00Z'}));
            api.draftExpiresAt.set(null);
            api.saveItem();

            const req = ctrl.expectOne(`${GUILD_URL}/pantry-items/pitm_1`);
            expect(req.request.body.clearExpiresAt).toBe(true);
            expect(req.request.body.expiresAt).toBeUndefined();
            req.flush(item({expiresAt: null}));
        });

        it('sends the date itself when one is set, with no clear flag alongside it', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openEdit(item());
            api.draftExpiresAt.set(new Date('2026-08-10T00:00:00Z'));
            api.saveItem();

            const req = ctrl.expectOne(`${GUILD_URL}/pantry-items/pitm_1`);
            expect(req.request.body.expiresAt).toBe('2026-08-10T00:00:00.000Z');
            expect(req.request.body.clearExpiresAt).toBeUndefined();
            req.flush(item({expiresAt: '2026-08-10T00:00:00Z'}));
        });

        it('clears a unit with an empty string, which is the only thing the PATCH honours', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openEdit(item({unit: 'l'}));
            api.draftUnit.set('');
            api.saveItem();

            const req = ctrl.expectOne(`${GUILD_URL}/pantry-items/pitm_1`);
            expect(req.request.body.unit).toBe('');
            req.flush(item({unit: null}));
        });

        it('still sends null on a create, where absent really is absent', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openAdd();
            api.draftName.set('Rice');
            api.draftQuantity.set(2);
            api.saveItem();

            const req = ctrl.expectOne(`${GUILD_URL}/channels/${CHANNEL_ID}/pantry-items`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body).toEqual({
                name: 'Rice', quantity: 2, unit: null, lowThreshold: null, expiresAt: null,
            });
            req.flush(item({id: 'pitm_2', name: 'Rice', quantity: 2, unit: null, lowThreshold: null}));
        });

        it('defaults a new item to untracked rather than inventing a threshold', () => {
            const {api} = setup({member: member('ManagePantry')});
            api.openAdd();
            expect(api.draftTrackRestock()).toBe(false);
        });
    });

    describe('config validation', () => {
        it('accepts the 1-90 bounds and rejects outside them before any request', () => {
            const {api} = setup({member: member('ManagePantry')});
            api.openConfig();

            api.cfgWarningDays.set(1);
            expect(api.cfgWarningDaysValid()).toBe(true);
            api.cfgWarningDays.set(90);
            expect(api.cfgWarningDaysValid()).toBe(true);
            api.cfgWarningDays.set(0);
            expect(api.cfgWarningDaysValid()).toBe(false);
            api.cfgWarningDays.set(91);
            expect(api.cfgWarningDaysValid()).toBe(false);

            // Nothing left the client while it was invalid.
            api.saveConfig();
            TestBed.inject(HttpTestingController).expectNone(`${GUILD_URL}/channels/${CHANNEL_ID}/pantry/config`);
        });

        it('PUTs clearRestockList to switch the loop off - a null id would be ignored', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openConfig();
            api.cfgListChannelId.set(null);
            api.saveConfig();

            const req = ctrl.expectOne(`${GUILD_URL}/channels/${CHANNEL_ID}/pantry/config`);
            expect(req.request.body).toEqual({clearRestockList: true, expiryWarningDays: 3});
            req.flush({channelId: CHANNEL_ID, restockListChannelId: null, expiryWarningDays: 3});
        });

        it('PUTs the chosen list id, with no clear flag alongside it', () => {
            const {api, ctrl} = setup({member: member('ManagePantry')});
            api.openConfig();
            api.cfgListChannelId.set('chan_list');
            api.saveConfig();

            const req = ctrl.expectOne(`${GUILD_URL}/channels/${CHANNEL_ID}/pantry/config`);
            expect(req.request.body).toEqual({restockListChannelId: 'chan_list', expiryWarningDays: 3});
            req.flush({channelId: CHANNEL_ID, restockListChannelId: 'chan_list', expiryWarningDays: 3});
        });
    });

    describe('rows', () => {
        it('badges a stamped row as listed rather than merely low', () => {
            const {api} = setup({items: [item({quantity: 1, restockedAt: '2026-08-03T10:00:00Z'})]});
            expect(api.rows()[0].state).toBe('listed');
        });

        it('falls back to a default warning window until the config arrives', () => {
            const {api} = setup({config: null});
            expect(api.warningDays()).toBe(3);
        });
    });
});
