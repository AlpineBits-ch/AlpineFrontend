import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {vi} from 'vitest';
import {RoleChannelsComponent} from './role-channels.component';
import {GuildService, OverridePermissionsDto} from '../../../../../../../services/guild.service';
import {ToastService} from '../../../../../../../services/toast.service';
import {
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

interface SetupOptions {
    channels: ChannelDto[];
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
    fixture.componentRef.setInput('categories', []);
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, guildService, toastService};
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

    it('reports a failed cell write via a toast and leaves the cell as it was', () => {
        const {component, guildService, toastService} = setup({channels: [channel('c1', ChannelType.Text)]});
        guildService.upsertChannelRolePermission.mockReturnValue(throwError(() => new Error('403')));

        component.setCell('c1', 'SendMessages', 'deny');

        expect(toastService.httpError).toHaveBeenCalled();
        expect(component.cellState('c1', 'SendMessages')).toBe('inherit');
    });
});
