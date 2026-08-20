import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {PermissionOverridesComponent} from './permission-overrides.component';
import {channelScope, categoryScope} from './permission-scope';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ChannelDto, ChannelType, GuildDto, RoleDto, RoleType} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';

const CHANNEL = 'chan_1';
const EVERYONE = 'role_everyone';
const PLAYER = 'role_player';

function role(id: string, name: string, type: RoleType): RoleDto {
    return {id, name, type, color: '#fff', permissions: 'None', position: 0} as RoleDto;
}

function guild(): GuildDto {
    return {
        id: 'guild_1',
        roles: [role(EVERYONE, 'everyone', RoleType.Everyone), role(PLAYER, 'player', RoleType.None)],
    } as GuildDto;
}

function channel(overrides: ChannelDto['permissions'] = []): ChannelDto {
    return {
        id: CHANNEL,
        name: 'general',
        type: ChannelType.Text,
        categoryId: 'cat_1',
        permissions: overrides,
        isPrivate: false,
    } as ChannelDto;
}

function memberDto(userId: string): GuildMemberDto {
    return {id: `mem_${userId}`, guildId: 'guild_1', userId} as GuildMemberDto;
}

interface SetupOptions {
    channelDto?: ChannelDto;
    members?: GuildMemberDto[];
    cached?: string[];
}

function setup(options: SetupOptions = {}) {
    const channelDto = options.channelDto ?? channel();
    const guildService = {
        upsertChannelRolePermission: vi.fn(() =>
            of({
                id: 'p1',
                channelId: CHANNEL,
                roleId: PLAYER,
                allowPermissions: 'SendMessages',
                denyPermissions: 'None',
            }),
        ),
        deleteChannelRolePermission: vi.fn(() => of(void 0)),
        upsertChannelMemberPermission: vi.fn(() => of({id: 'p2'})),
        deleteChannelMemberPermission: vi.fn(() => of(void 0)),
        getMembers: vi.fn(() => of(options.members ?? ([] as GuildMemberDto[]))),
        searchMembers: vi.fn(() => of([] as GuildMemberDto[])),
    };

    const profileService = {
        fetchByUserId: vi.fn(() => of({userName: 'ada'})),
        getCachedByUserId: vi.fn((userId: string) =>
            (options.cached ?? []).includes(userId) ? {userName: userId} : undefined,
        ),
        resolveByUserId: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [PermissionOverridesComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
            {provide: ProfileService, useValue: profileService},
        ],
    });

    const fixture: ComponentFixture<PermissionOverridesComponent> = TestBed.createComponent(
        PermissionOverridesComponent,
    );
    fixture.componentRef.setInput('scope', channelScope(channelDto));
    fixture.componentRef.setInput('guild', guild());
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, guildService, profileService};
}

function setupCategory() {
    const guildService = {
        upsertCategoryRolePermission: vi.fn(() => of({id: 'p1'})),
        deleteCategoryRolePermission: vi.fn(() => of(void 0)),
        upsertCategoryMemberPermission: vi.fn(() => of({id: 'p2'})),
        deleteCategoryMemberPermission: vi.fn(() => of(void 0)),
        getMembers: vi.fn(() => of([])),
    };

    TestBed.configureTestingModule({
        imports: [PermissionOverridesComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
            {provide: ProfileService, useValue: {fetchByUserId: vi.fn(() => of({userName: 'ada'}))}},
        ],
    });

    const fixture = TestBed.createComponent(PermissionOverridesComponent);
    fixture.componentRef.setInput('scope', categoryScope({id: 'cat_1', permissions: []} as never));
    fixture.componentRef.setInput('guild', guild());
    fixture.detectChanges();

    return {component: fixture.componentInstance, guildService};
}

describe('PermissionOverridesComponent', () => {
    it('lists only roles that already carry an override, plus @everyone pinned last', () => {
        const {component} = setup({
            channelDto: channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        });

        const entries = component['roleEntries']();

        expect(entries.map(e => e.id)).toEqual([PLAYER, EVERYONE]);
        expect(entries[1].pinned).toBe(true);
    });

    it('offers every role without an override as addable, never @everyone', () => {
        const {component} = setup();

        expect(component['addableRoles']().map(e => e.id)).toEqual([PLAYER]);
    });

    it('marks a changed row dirty without saving it', () => {
        const {component, guildService} = setup();

        component.onAddRole(PLAYER);

        expect(component['roleEntries']().find(e => e.id === PLAYER)?.dirty).toBe(true);
        expect(guildService.upsertChannelRolePermission).not.toHaveBeenCalled();
    });

    it('saves the allow and deny masks as name lists', () => {
        const {component, guildService} = setup();

        component.onRoleChange(PLAYER, {
            allow: 2n, // SendMessages
            deny: 1n, // ViewChannel
            allowModule: 0n,
            denyModule: 0n,
        });
        component.saveRole(PLAYER);

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER, {
            allowPermissions: 'SendMessages',
            denyPermissions: 'ViewChannel',
        });
    });

    it('clears the row back to inherit when the override is deleted', () => {
        const {component, guildService} = setup({
            channelDto: channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        });

        component.deleteRole(PLAYER);

        expect(guildService.deleteChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER);
        expect(component['roleEntries']().map(e => e.id)).toEqual([EVERYONE]);
    });

    it('loads members only when the members tab is opened', () => {
        const {component, guildService} = setup();

        expect(guildService.getMembers).not.toHaveBeenCalled();

        component.switchTab('members');

        expect(guildService.getMembers).toHaveBeenCalled();
    });

    it('routes a category scope to the category endpoints', () => {
        const {component, guildService} = setupCategory();

        component.onRoleChange(PLAYER, {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n});
        component.saveRole(PLAYER);

        expect(guildService.upsertCategoryRolePermission).toHaveBeenCalledWith('cat_1', PLAYER, {
            allowPermissions: 'SendMessages',
            denyPermissions: 'None',
        });
    });
});

describe('PermissionOverridesComponent scope reconciliation', () => {
    it('keeps a dirty row pending and refreshes a clean one when the overwrites change', () => {
        const {fixture, component} = setup({
            channelDto: channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        });

        // An unsaved edit: deny SendMessages instead of allowing it.
        component.onRoleChange(PLAYER, {allow: 0n, deny: 2n, allowModule: 0n, denyModule: 0n});

        // The page re-syncs the channel: the server now denies ViewChannel for both.
        const resynced = channel([
            {
                id: 'p1',
                channelId: CHANNEL,
                roleId: PLAYER,
                allowPermissions: 'None',
                denyPermissions: 'ViewChannel',
            } as ChannelDto['permissions'][number],
            {
                id: 'p2',
                channelId: CHANNEL,
                roleId: EVERYONE,
                allowPermissions: 'None',
                denyPermissions: 'ViewChannel',
            } as ChannelDto['permissions'][number],
        ]);
        fixture.componentRef.setInput('scope', channelScope(resynced));
        fixture.detectChanges();

        const rows = component['roleEntries']();
        const playerRow = rows.find(e => e.id === PLAYER);
        const everyoneRow = rows.find(e => e.id === EVERYONE);

        expect(playerRow?.dirty).toBe(true);
        expect(playerRow?.override.deny).toBe(2n); // still the pending edit, not the server's ViewChannel deny

        expect(everyoneRow?.dirty).toBe(false);
        expect(everyoneRow?.override.deny).toBe(1n); // picked up from the resync
    });

    it('reflects a new @everyone ViewChannel deny once the scope resyncs', () => {
        const {fixture, component} = setup();

        expect(component['roleEntries']().find(e => e.id === EVERYONE)?.override.deny).toBe(0n);

        const madePrivate = channel([
            {
                id: 'p1',
                channelId: CHANNEL,
                roleId: EVERYONE,
                allowPermissions: 'None',
                denyPermissions: 'ViewChannel',
            } as ChannelDto['permissions'][number],
        ]);
        fixture.componentRef.setInput('scope', channelScope(madePrivate));
        fixture.detectChanges();

        const everyoneRow = component['roleEntries']().find(e => e.id === EVERYONE);
        expect(everyoneRow?.dirty).toBe(false);
        expect(everyoneRow?.override.deny).toBe(1n);
    });

    it('does not refetch members while reconciling a resync', () => {
        const {fixture, component, guildService} = setup({members: [memberDto('ada')]});

        component.switchTab('members');
        expect(guildService.getMembers).toHaveBeenCalledTimes(1);

        const resynced = channel([
            {
                id: 'p1',
                channelId: CHANNEL,
                roleId: EVERYONE,
                allowPermissions: 'None',
                denyPermissions: 'ViewChannel',
            } as ChannelDto['permissions'][number],
        ]);
        fixture.componentRef.setInput('scope', channelScope(resynced));
        fixture.detectChanges();

        expect(guildService.getMembers).toHaveBeenCalledTimes(1);
    });
});

describe('PermissionOverridesComponent members tab', () => {
    it('reads one page of members, not the whole guild', () => {
        const {component, guildService} = setup();

        component.switchTab('members');

        expect(guildService.getMembers).toHaveBeenCalledWith('guild_1', 0, 50);
    });

    it('never uses the cache-bypassing profile read', () => {
        const {component, profileService} = setup({members: [memberDto('ada'), memberDto('bo')]});

        component.switchTab('members');

        expect(profileService.fetchByUserId).not.toHaveBeenCalled();
        expect(profileService.getCachedByUserId).toHaveBeenCalledTimes(2);
    });

    it('asks the resolver only for the ids the cache missed', () => {
        const {component, profileService} = setup({
            members: [memberDto('ada'), memberDto('bo')],
            cached: ['ada'],
        });

        component.switchTab('members');

        expect(profileService.resolveByUserId).toHaveBeenCalledTimes(1);
        expect(profileService.resolveByUserId).toHaveBeenCalledWith('bo');
    });

    it('appends the next page rather than replacing the list', () => {
        // A full 50-row page: production reads a shorter page as the last one, so a mock that
        // returns fewer than the page size would make `loadMoreMembers` correctly decline to fetch.
        const fullPage = Array.from({length: 50}, (_, i) => memberDto(`m${i}`));
        const {component, guildService} = setup({members: fullPage});

        component.switchTab('members');
        component.loadMoreMembers();

        expect(guildService.getMembers).toHaveBeenLastCalledWith('guild_1', 50, 50);
    });

    // A short first page (fewer rows than the page size) against a page size of 50: skip += size and
    // hasMore = length > 0 both also produce hasMore = true here, which is the regression this guards.
    it('offers no more pages once a short page comes back', () => {
        const {component, guildService} = setup({members: [memberDto('ada'), memberDto('bo')]});

        component.switchTab('members');

        expect(component['hasMoreMembers']()).toBe(false);

        component.loadMoreMembers();

        expect(guildService.getMembers).toHaveBeenCalledTimes(1);
    });

    it('replaces the list with search results while a term is set', () => {
        const {component, guildService} = setup();

        component.switchTab('members');
        component.searchMembers('ad');

        expect(guildService.searchMembers).toHaveBeenCalledWith('guild_1', 'ad');
    });

    it('goes back to the paged list when the term is cleared', () => {
        const {component, guildService} = setup();

        component.switchTab('members');
        component.searchMembers('ad');
        guildService.getMembers.mockClear();
        component.searchMembers('');

        expect(guildService.getMembers).toHaveBeenCalledWith('guild_1', 0, 50);
    });

    it('debounces the search box 250ms before searching', async () => {
        vi.useFakeTimers();
        try {
            const {component, guildService} = setup();

            component.switchTab('members');
            component.onMemberQuery('a');
            component.onMemberQuery('ad');
            expect(guildService.searchMembers).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(250);

            expect(guildService.searchMembers).toHaveBeenCalledTimes(1);
            expect(guildService.searchMembers).toHaveBeenCalledWith('guild_1', 'ad');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('PermissionOverridesComponent module masks', () => {
    it('sends the module masks when they carry anything', () => {
        const {component, guildService} = setup();

        component.onRoleChange(PLAYER, {
            allow: 0n,
            deny: 0n,
            allowModule: 1n << 10n, // AddListItems
            denyModule: 0n,
        });
        component.saveRole(PLAYER);

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER, {
            allowPermissions: 'None',
            denyPermissions: 'None',
            allowModulePermissions: 'AddListItems',
            denyModulePermissions: 'None',
        });
    });

    // Omitting them means "carry over" on the server, which is the right default for a subject
    // whose module masks were never touched here.
    it('omits the module masks when nothing set them', () => {
        const {component, guildService} = setup();

        component.onRoleChange(PLAYER, {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n});
        component.saveRole(PLAYER);

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER, {
            allowPermissions: 'SendMessages',
            denyPermissions: 'None',
        });
    });
});
