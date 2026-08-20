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

function setup(channelDto = channel()) {
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
        getMembers: vi.fn(() => of([] as GuildMemberDto[])),
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

    const fixture: ComponentFixture<PermissionOverridesComponent> = TestBed.createComponent(
        PermissionOverridesComponent,
    );
    fixture.componentRef.setInput('scope', channelScope(channelDto));
    fixture.componentRef.setInput('guild', guild());
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, guildService};
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
        const {component} = setup(
            channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        );

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
        const {component, guildService} = setup(
            channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        );

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
