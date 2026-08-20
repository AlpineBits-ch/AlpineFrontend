import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {ALL_CHANNEL_COLUMNS, columnsFor} from './role-channel-columns';
import {
    EMPTY_OVERRIDE,
    OverrideState,
    PermOverride,
} from '../../../../../shared/permission-override-editor/permission-override-editor.component';
import {
    CategoryDto,
    ChannelDto,
    ChannelPermission,
    GuildDto,
    RoleDto,
} from '../../../../../../../dtos/response/guild.dto';
import {
    permissionLabel,
    PermissionKey,
    Permissions,
    parsePermissions,
    stringifyPermissions,
} from '../../../../../../../enums/permissions.enum';
import {parseModulePermissions} from '../../../../../../../enums/module-permissions.enum';
import {GuildService} from '../../../../../../../services/guild.service';

interface RoleChannelRow {
    channel: ChannelDto;
    categoryLabel: string;
}

function toOverride(perm: ChannelPermission): PermOverride {
    return {
        allow: parsePermissions(perm.allowPermissions),
        deny: parsePermissions(perm.denyPermissions),
        allowModule: parseModulePermissions(perm.allowModulePermissions ?? 'None'),
        denyModule: parseModulePermissions(perm.denyModulePermissions ?? 'None'),
    };
}

@Component({
    selector: 'app-role-channels',
    imports: [NgClass, Tooltip, TranslateModule],
    templateUrl: './role-channels.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoleChannelsComponent {
    readonly guild = input.required<GuildDto>();
    readonly role = input.required<RoleDto>();
    readonly channels = input.required<ChannelDto[]>();
    readonly categories = input.required<CategoryDto[]>();

    private readonly guildService = inject(GuildService);

    /** Keyed by channel id, holding only this role's override on that channel. */
    private readonly overrides = signal<Map<string, PermOverride>>(new Map());

    protected readonly rows = computed<RoleChannelRow[]>(() => {
        const categoryNames = new Map(this.categories().map(c => [c.id, c.name]));
        return [...this.channels()]
            .sort((a, b) => a.position - b.position)
            .map(channel => ({
                channel,
                categoryLabel: channel.categoryId ? (categoryNames.get(channel.categoryId) ?? '') : '',
            }));
    });

    protected readonly overrideCount = computed(() => this.overrides().size);
    protected readonly totalChannels = computed(() => this.channels().length);

    constructor() {
        // Role or channel list changed: rebuild the map from what the server has, dropping any edits.
        effect(() => {
            const roleId = this.role().id;
            const map = new Map<string, PermOverride>();
            for (const channel of this.channels()) {
                const perm = channel.permissions.find(p => p.roleId === roleId);
                if (perm) map.set(channel.id, toOverride(perm));
            }
            this.overrides.set(map);
        });
    }

    protected get columns(): PermissionKey[] {
        return ALL_CHANNEL_COLUMNS;
    }

    label(key: PermissionKey): string {
        return permissionLabel(key);
    }

    applies(channelId: string, key: PermissionKey): boolean {
        const channel = this.channels().find(c => c.id === channelId);
        if (!channel) return false;
        return columnsFor(channel.type).includes(key);
    }

    cellState(channelId: string, key: PermissionKey): OverrideState {
        const val = Permissions[key];
        const current = this.overrideFor(channelId);
        if ((current.allow & val) === val) return 'allow';
        if ((current.deny & val) === val) return 'deny';
        return 'inherit';
    }

    /** Cycles a cell inherit, allow, deny, inherit on each click. */
    cycleCell(channelId: string, key: PermissionKey): void {
        const order: OverrideState[] = ['inherit', 'allow', 'deny'];
        const next = order[(order.indexOf(this.cellState(channelId, key)) + 1) % order.length];
        this.setCell(channelId, key, next);
    }

    setCell(channelId: string, key: PermissionKey, state: OverrideState): void {
        const current = this.overrideFor(channelId);
        const val = Permissions[key];

        let allow = current.allow & ~val;
        let deny = current.deny & ~val;
        if (state === 'allow') allow |= val;
        else if (state === 'deny') deny |= val;

        if (allow === 0n && deny === 0n && current.allowModule === 0n && current.denyModule === 0n) {
            this.guildService.deleteChannelRolePermission(channelId, this.role().id).subscribe({
                next: () => this.forget(channelId),
            });
            return;
        }

        this.guildService
            .upsertChannelRolePermission(channelId, this.role().id, {
                allowPermissions: stringifyPermissions(allow),
                denyPermissions: stringifyPermissions(deny),
            })
            .subscribe({next: perm => this.remember(channelId, perm)});
    }

    private overrideFor(channelId: string): PermOverride {
        return this.overrides().get(channelId) ?? EMPTY_OVERRIDE;
    }

    private remember(channelId: string, perm: ChannelPermission): void {
        this.overrides.update(map => {
            const next = new Map(map);
            next.set(channelId, toOverride(perm));
            return next;
        });
    }

    private forget(channelId: string): void {
        this.overrides.update(map => {
            const next = new Map(map);
            next.delete(channelId);
            return next;
        });
    }
}
