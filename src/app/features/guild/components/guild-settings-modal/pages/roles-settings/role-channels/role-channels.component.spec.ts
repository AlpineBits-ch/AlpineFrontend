import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {vi} from 'vitest';
import {RoleChannelsComponent} from './role-channels.component';
import {GuildService, OverridePermissionsDto} from '../../../../../../../services/guild.service';
import {ToastService} from '../../../../../../../services/toast.service';
import {Permissions} from '../../../../../../../enums/permissions.enum';
import {
    CategoryDto,
    ChannelDto,
    ChannelPermission,
    ChannelType,
    GuildDto,
    RoleDto,
    RoleType,
} from '../../../../../../../dtos/response/guild.dto';

const ROLE = 'role_1';

function role(): RoleDto {
    return {
        id: ROLE,
        name: 'recruit',
        type: RoleType.None,
        color: '#fff',
        permissions: 'None',
        position: 1,
    } as RoleDto;
}

function guild(): GuildDto {
    return {id: 'guild_1'} as GuildDto;
}

function channel(id: string, type: ChannelType, override?: Partial<ChannelPermission>): ChannelDto {
    const permissions: ChannelPermission[] = override
        ? [
              {
                  id: 'p_' + id,
                  roleId: ROLE,
                  memberId: undefined,
                  channelId: id,
                  categoryId: undefined,
                  allowPermissions: 'None',
                  denyPermissions: 'None',
                  ...override,
              } as ChannelPermission,
          ]
        : [];
    return {
        id,
        name: id,
        type,
        categoryId: undefined,
        permissions,
        position: 0,
    } as ChannelDto;
}

function category(id: string, name: string, position: number): CategoryDto {
    return {
        id,
        createdAt: new Date(),
        updatedAt: new Date(),
        name,
        description: '',
        permissions: [],
        position,
    };
}

interface SetupOptions {
    channels: ChannelDto[];
    categories?: CategoryDto[];
}

function setup(options: SetupOptions) {
    const guildService = {
        upsertChannelRolePermission: vi.fn((channelId: string, roleId: string, dto: OverridePermissionsDto) =>
            of({
                id: 'p',
                roleId,
                memberId: undefined,
                channelId,
                categoryId: undefined,
                allowPermissions: dto.allowPermissions,
                denyPermissions: dto.denyPermissions,
            } as ChannelPermission),
        ),
        deleteChannelRolePermission: vi.fn(() => of(undefined)),
        getChannel: vi.fn((id: string) => of(channel(id, ChannelType.Text))),
    };

    const toastService = {
        error: vi.fn(),
        httpError: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [RoleChannelsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
            {provide: ToastService, useValue: toastService},
        ],
    });

    const fixture: ComponentFixture<RoleChannelsComponent> = TestBed.createComponent(RoleChannelsComponent);
    fixture.componentRef.setInput('guild', guild());
    fixture.componentRef.setInput('role', role());
    fixture.componentRef.setInput('channels', options.channels);
    fixture.componentRef.setInput('categories', options.categories ?? []);
    fixture.detectChanges();

    const translate = TestBed.inject(TranslateService);
    vi.spyOn(translate, 'instant');

    return {fixture, component: fixture.componentInstance, guildService, toastService, translate};
}

describe('RoleChannelsComponent', () => {
    it('shows a channel with no override as inherited', () => {
        const {component} = setup({channels: [channel('c1', ChannelType.Text)]});

        expect(component.cellState('c1', 'SendMessages')).toBe('inherit');
    });

    it("reads allow and deny off the role's override", () => {
        const {component} = setup({
            channels: [
                channel('c1', ChannelType.Text, {
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'CreateThreads',
                }),
            ],
        });

        expect(component.cellState('c1', 'SendMessages')).toBe('allow');
        expect(component.cellState('c1', 'CreateThreads')).toBe('deny');
    });

    it('writes the whole override when a cell changes', () => {
        const {component, guildService} = setup({channels: [channel('c1', ChannelType.Text)]});

        component.setCell('c1', 'SendMessages', 'deny');

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith('c1', ROLE, {
            allowPermissions: 'None',
            denyPermissions: 'SendMessages',
        });
    });

    it('deletes the override when the last bit is cleared', () => {
        const {component, guildService} = setup({
            channels: [
                channel('c1', ChannelType.Text, {allowPermissions: 'SendMessages', denyPermissions: 'None'}),
            ],
        });

        component.setCell('c1', 'SendMessages', 'inherit');

        expect(guildService.deleteChannelRolePermission).toHaveBeenCalledWith('c1', ROLE);
        expect(guildService.upsertChannelRolePermission).not.toHaveBeenCalled();
    });

    it('offers no control where the column does not apply to the row', () => {
        const {component} = setup({channels: [channel('c1', ChannelType.Voice)]});

        expect(component.applies('c1', 'SendMessages')).toBe(false);
        expect(component.applies('c1', 'Connect')).toBe(true);
    });

    it("opens the apply dialog seeded with the row's own override", () => {
        const {component} = setup({
            channels: [
                channel('c1', ChannelType.Text, {allowPermissions: 'SendMessages', denyPermissions: 'None'}),
            ],
        });

        component.openApplyDialog('c1');

        expect(component['showApplyDialog']()).toBe(true);
        expect(component['applyOverride']().allow).toBe(Permissions.SendMessages);
    });

    it('excludes the source channel from the apply dialog targets', () => {
        const {component} = setup({
            channels: [channel('c1', ChannelType.Text), channel('c2', ChannelType.Text)],
        });

        component.openApplyDialog('c1');

        expect(component['applyTargets']().map(c => c.id)).toEqual(['c2']);
    });

    it('refreshes a channel the apply dialog reports succeeded', () => {
        const {component, guildService} = setup({
            channels: [channel('c1', ChannelType.Text), channel('c2', ChannelType.Text)],
        });
        guildService.getChannel.mockReturnValue(
            of(channel('c2', ChannelType.Text, {allowPermissions: 'SendMessages', denyPermissions: 'None'})),
        );

        component.onApplied({succeeded: ['c2'], failed: []});

        expect(guildService.getChannel).toHaveBeenCalledWith('c2');
        expect(component.cellState('c2', 'SendMessages')).toBe('allow');
    });

    it('surfaces apply failures via a toast instead of swallowing them', () => {
        const {component, toastService} = setup({channels: [channel('c1', ChannelType.Text)]});

        component.onApplied({succeeded: [], failed: ['c9']});

        expect(toastService.error).toHaveBeenCalled();
    });

    it('chooses the singular apply-failure key for exactly one failed channel', () => {
        const {component, translate} = setup({channels: [channel('c1', ChannelType.Text)]});

        component.onApplied({succeeded: [], failed: ['c9']});

        expect(translate.instant).toHaveBeenCalledWith('ROLE_CHANNELS.APPLY_PARTIAL_FAILURE_ONE', {count: 1});
    });

    it('chooses the plural apply-failure key for more than one failed channel', () => {
        const {component, translate} = setup({channels: [channel('c1', ChannelType.Text)]});

        component.onApplied({succeeded: [], failed: ['c8', 'c9']});

        expect(translate.instant).toHaveBeenCalledWith('ROLE_CHANNELS.APPLY_PARTIAL_FAILURE', {count: 2});
    });

    it('drops voice columns from the header when the guild has no voice channels', () => {
        const {component} = setup({channels: [channel('c1', ChannelType.Text)]});

        expect(component['columns']()).not.toContain('Connect');
    });

    it('adds voice columns to the header once the guild has a voice channel', () => {
        const {component} = setup({
            channels: [channel('c1', ChannelType.Text), channel('c2', ChannelType.Voice)],
        });

        expect(component['columns']()).toContain('Connect');
    });

    it('groups channels under their category, with uncategorised channels leading', () => {
        const cat = category('cat_1', 'Voice Channels', 0);
        const {component} = setup({
            channels: [
                {...channel('c1', ChannelType.Text), categoryId: 'cat_1', position: 0},
                {...channel('c2', ChannelType.Text), categoryId: undefined, position: 0},
            ],
            categories: [cat],
        });

        const groups = component['groups']();

        expect(groups).toEqual([
            {category: null, channels: [expect.objectContaining({id: 'c2'})]},
            {category: cat, channels: [expect.objectContaining({id: 'c1'})]},
        ]);
    });

    it('reports a failed cell write via a toast and leaves the cell as it was', () => {
        const {component, guildService, toastService} = setup({channels: [channel('c1', ChannelType.Text)]});
        guildService.upsertChannelRolePermission.mockReturnValue(throwError(() => new Error('403')));

        component.setCell('c1', 'SendMessages', 'deny');

        expect(toastService.httpError).toHaveBeenCalled();
        expect(component.cellState('c1', 'SendMessages')).toBe('inherit');
    });
});
