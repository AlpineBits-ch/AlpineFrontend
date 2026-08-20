import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {ChannelPermissionsComponent} from './channel-permissions.component';
import {GuildService} from '../../../../../../services/guild.service';
import {
    CategoryDto,
    ChannelDto,
    ChannelPermission,
    ChannelType,
    GuildDto,
    RoleType,
} from '../../../../../../dtos/response/guild.dto';

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
}

function setup(options: SetupOptions = {}) {
    const categoryId = 'categoryId' in options ? options.categoryId : CATEGORY;
    const channelDto = channel(options.channelOverrides ?? [], categoryId);
    const categoryDto = category(options.categoryOverrides ?? []);

    const guildService = {
        updateChannel: vi.fn(() => of({...channelDto, isPrivate: true})),
        syncChannelPermissions: vi.fn(() => of([] as ChannelPermission[])),
    };

    TestBed.configureTestingModule({
        imports: [ChannelPermissionsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
        ],
    });

    const fixture: ComponentFixture<ChannelPermissionsComponent> =
        TestBed.createComponent(ChannelPermissionsComponent);
    fixture.componentRef.setInput('channel', channelDto);
    fixture.componentRef.setInput('guild', guild());
    fixture.componentRef.setInput('categories', [categoryDto]);
    fixture.detectChanges();

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
});
