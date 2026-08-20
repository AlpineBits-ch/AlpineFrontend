import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {vi} from 'vitest';
import {ApplyOverrideDialogComponent} from './apply-override-dialog.component';
import {GuildService} from '../../../../services/guild.service';
import {ChannelDto, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {
    EMPTY_OVERRIDE,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';
import {stringifyPermissions} from '../../../../enums/permissions.enum';
import {stringifyModulePermissions} from '../../../../enums/module-permissions.enum';

const ROLE_ID = 'role_1';

function channel(id: string, categoryId?: string, existing?: PermOverride): ChannelDto {
    return {
        id,
        name: id,
        type: ChannelType.Text,
        categoryId,
        isPrivate: false,
        permissions: existing
            ? [
                  {
                      id: `perm_${id}`,
                      channelId: id,
                      roleId: ROLE_ID,
                      memberId: undefined,
                      categoryId: undefined,
                      allowPermissions: stringifyPermissions(existing.allow),
                      denyPermissions: stringifyPermissions(existing.deny),
                      allowModulePermissions: stringifyModulePermissions(existing.allowModule),
                      denyModulePermissions: stringifyModulePermissions(existing.denyModule),
                  },
              ]
            : [],
    } as ChannelDto;
}

function guild(): GuildDto {
    return {id: 'guild_1', roles: []} as unknown as GuildDto;
}

interface SetupOptions {
    channels: ChannelDto[];
    existing?: Record<string, PermOverride>;
    override?: PermOverride;
}

function setup(options: SetupOptions) {
    const channels = options.channels.map(c => {
        const existing = options.existing?.[c.id];
        return existing ? channel(c.id, c.categoryId, existing) : c;
    });

    const guildService = {
        upsertChannelRolePermission: vi.fn(() => of({id: 'p'})),
    };

    TestBed.configureTestingModule({
        imports: [ApplyOverrideDialogComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
        ],
    });

    const fixture: ComponentFixture<ApplyOverrideDialogComponent> = TestBed.createComponent(
        ApplyOverrideDialogComponent,
    );
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('guild', guild());
    fixture.componentRef.setInput('roleId', ROLE_ID);
    fixture.componentRef.setInput('override', options.override ?? {...EMPTY_OVERRIDE, allow: 2n});
    fixture.componentRef.setInput('channels', channels);
    fixture.componentRef.setInput('categories', []);
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, guildService};
}

describe('ApplyOverrideDialogComponent', () => {
    it('sends one write per selected channel, skipping the no-ops', async () => {
        const {component, guildService} = setup({
            channels: [channel('c1'), channel('c2'), channel('c3')],
        });

        component.toggleChannel('c1');
        component.toggleChannel('c2');
        await component.apply();

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledTimes(2);
    });

    it('selects and clears a whole category at once', () => {
        const {component} = setup({
            channels: [channel('c1', 'cat1'), channel('c2', 'cat1')],
        });

        component.toggleCategory('cat1');
        expect(component.selectedCount()).toBe(2);

        component.toggleCategory('cat1');
        expect(component.selectedCount()).toBe(0);
    });

    it('reports the channels that failed rather than stopping', async () => {
        const {component, guildService} = setup({channels: [channel('c1'), channel('c2')]});
        guildService.upsertChannelRolePermission
            .mockReturnValueOnce(throwError(() => new Error('nope')))
            .mockReturnValueOnce(of({id: 'p'}));

        component.toggleChannel('c1');
        component.toggleChannel('c2');
        const result = await component.apply();

        expect(result.failed).toEqual(['c1']);
        expect(result.succeeded).toEqual(['c2']);
    });

    it('counts what a sync would skip before anything is sent', () => {
        const {component} = setup({
            channels: [channel('c1')],
            existing: {c1: {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n}},
            override: {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n},
        });

        component.toggleChannel('c1');

        expect(component.skippedCount()).toBe(1);
    });
});
