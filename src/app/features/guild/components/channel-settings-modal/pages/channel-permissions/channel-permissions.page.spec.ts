import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {ChannelPermissionsComponent} from './channel-permissions.component';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {
    CategoryDto,
    ChannelDto,
    ChannelPermission,
    ChannelType,
    GuildDto,
    RoleType,
} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';

const CHANNEL = 'chan_1';
const CATEGORY = 'cat_1';

function perm(over: Partial<ChannelPermission>): ChannelPermission {
    return {
        id: 'p',
        roleId: undefined,
        memberId: undefined,
        allowPermissions: 'None',
        denyPermissions: 'None',
        ...over,
    } as ChannelPermission;
}

function channel(overrides: ChannelPermission[], categoryId: string | undefined): ChannelDto {
    return {
        id: CHANNEL,
        name: 'general',
        type: ChannelType.Text,
        categoryId,
        permissions: overrides,
        isPrivate: false,
    } as ChannelDto;
}

function guild(): GuildDto {
    return {
        id: 'guild_1',
        roles: [
            {
                id: 'role_everyone',
                name: 'everyone',
                type: RoleType.Everyone,
                color: '#fff',
                permissions: 'None',
                position: 0,
            },
            {
                id: 'r1',
                name: 'role one',
                type: RoleType.None,
                color: '#fff',
                permissions: 'None',
                position: 1,
            },
        ],
    } as GuildDto;
}

function category(overrides: ChannelPermission[] = []): CategoryDto {
    return {
        id: CATEGORY,
        name: 'general category',
        description: '',
        permissions: overrides,
        position: 0,
    } as CategoryDto;
}

interface SetupOptions {
    channelOverrides?: ChannelPermission[];
    categoryOverrides?: ChannelPermission[];
    categoryId?: string | undefined;
    members?: GuildMemberDto[];
}

function setup(options: SetupOptions = {}) {
    const categoryId = 'categoryId' in options ? options.categoryId : CATEGORY;
    const channelDto = channel(options.channelOverrides ?? [], categoryId);
    const categoryDto = category(options.categoryOverrides ?? []);

    const guildService = {
        updateChannel: vi.fn(() => of({...channelDto, isPrivate: true})),
        syncChannelPermissions: vi.fn(() => of([] as ChannelPermission[])),
        // injectGuildRoster's own reads, not exercised by most cases here.
        getMembers: vi.fn(() => of(options.members ?? ([] as GuildMemberDto[]))),
        getOwnMember: vi.fn(() => of(null)),
    };

    // The advanced disclosure now stays mounted (Finding 4), so app-permission-overrides is
    // always constructed and needs its own dependencies satisfied, not just this page's.
    const profileService = {
        fetchByUserId: vi.fn(() => of({userName: 'ada'})),
        getCachedByUserId: vi.fn(() => undefined),
        resolveByUserId: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [ChannelPermissionsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
            {provide: ProfileService, useValue: profileService},
        ],
    });

    const fixture: ComponentFixture<ChannelPermissionsComponent> =
        TestBed.createComponent(ChannelPermissionsComponent);
    fixture.componentRef.setInput('channel', channelDto);
    fixture.componentRef.setInput('guild', guild());
    fixture.componentRef.setInput('categories', [categoryDto]);
    fixture.detectChanges();
    TestBed.tick();

    return {fixture, component: fixture.componentInstance, guildService};
}

describe('ChannelPermissionsComponent page', () => {
    it('reports synced when the channel matches its category', () => {
        const {component} = setup({channelOverrides: [], categoryOverrides: []});

        expect(component.synced()).toBe(true);
    });

    it('counts the overrides that differ', () => {
        const {component} = setup({
            channelOverrides: [perm({roleId: 'r1', denyPermissions: 'SendMessages'})],
            categoryOverrides: [perm({roleId: 'r2'})],
        });

        expect(component.synced()).toBe(false);
        expect(component.divergingCount()).toBe(2);
    });

    it('offers no sync row for a channel with no category', () => {
        const {component} = setup({categoryId: undefined});

        expect(component.category()).toBeNull();
    });

    it('calls the sync route and re-reads the channel', () => {
        const {component, guildService} = setup({
            channelOverrides: [perm({roleId: 'r1'})],
            categoryOverrides: [],
        });

        component.resync();

        expect(guildService.syncChannelPermissions).toHaveBeenCalledWith(CHANNEL);
    });

    it('writes the private flag through updateChannel', () => {
        const {component, guildService} = setup();

        component.setPrivate(true);

        expect(guildService.updateChannel).toHaveBeenCalledWith(CHANNEL, {isPrivate: true});
    });

    // Finding 1 (fix round 1): the scope handed to the editor must carry the server's answer,
    // not the channel input's stale snapshot. Reconciling the editor's own rows against that
    // scope is owned by a different agent working inside permission-overrides.component.ts;
    // this only proves the scope itself is fresh.
    it('feeds the editor the overwrites updateChannel just returned', () => {
        const {component, guildService} = setup({channelOverrides: [perm({roleId: 'r1'})]});
        const freshRows = [perm({roleId: 'r1', allowPermissions: 'SendMessages'})];
        guildService.updateChannel.mockReturnValue(of({...channel(freshRows, CATEGORY), isPrivate: true}));

        component.setPrivate(true);

        expect(component['scope']().overrides).toBe(freshRows);
    });

    it('feeds the editor the overwrites a re-sync just returned', () => {
        const {component, guildService} = setup({channelOverrides: [perm({roleId: 'r1'})]});
        const freshRows = [perm({roleId: 'r1', allowPermissions: 'AddReactions'})];
        guildService.syncChannelPermissions.mockReturnValue(of(freshRows));

        component.resync();

        expect(component['scope']().overrides).toBe(freshRows);
    });

    it('emits the channel updateChannel returned, so a reopened modal is not stale', () => {
        const {component, guildService} = setup();
        const updated = {...channel([], CATEGORY), isPrivate: true};
        guildService.updateChannel.mockReturnValue(of(updated));
        const emitted: ChannelDto[] = [];
        component.channelUpdated.subscribe(c => emitted.push(c));

        component.setPrivate(true);

        expect(emitted).toEqual([updated]);
    });

    it('emits a re-synced channel whose isPrivate agrees with its own @everyone row', () => {
        const everyoneDeny = perm({roleId: 'role_everyone', denyPermissions: 'ViewChannel'});
        const {component, guildService} = setup();
        guildService.syncChannelPermissions.mockReturnValue(of([everyoneDeny]));
        const emitted: ChannelDto[] = [];
        component.channelUpdated.subscribe(c => emitted.push(c));

        component.resync();

        expect(emitted).toEqual([expect.objectContaining({isPrivate: true, permissions: [everyoneDeny]})]);
    });

    it('emits a re-synced channel as public when the resync clears the everyone deny', () => {
        const {component, guildService} = setup();
        guildService.syncChannelPermissions.mockReturnValue(of([]));
        const emitted: ChannelDto[] = [];
        component.channelUpdated.subscribe(c => emitted.push(c));

        component.resync();

        expect(emitted[0].isPrivate).toBe(false);
    });

    it('resolves a member override to a name via the shared roster, not a raw id', () => {
        const {component} = setup({
            members: [
                {id: 'mem_1', userId: 'user_1', nickname: null, profile: {userName: 'Ada'}} as GuildMemberDto,
            ],
        });

        expect(component.nameOf({targetId: 'mem_1', kind: 'member'})).toBe('Ada');
    });

    it('falls back to the unknown-member copy for a member the roster never loaded', () => {
        const {component} = setup();

        expect(component.nameOf({targetId: 'mem_missing', kind: 'member'})).not.toBe('mem_missing');
    });
});
