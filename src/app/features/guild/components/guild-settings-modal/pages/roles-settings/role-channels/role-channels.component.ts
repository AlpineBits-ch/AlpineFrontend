import {ChangeDetectionStrategy, Component, computed, inject, input, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {columnsFor, columnsPresent} from './role-channel-columns';
import {
    EMPTY_OVERRIDE,
    OverrideState,
    PermOverride,
} from '../../../../../shared/permission-override-editor/permission-override-editor.component';
import {ApplyOverrideDialogComponent} from '../../../../../shared/apply-override-dialog/apply-override-dialog.component';
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
import {ToastService} from '../../../../../../../services/toast.service';

/** One category's channels, in position order. `category` is null for the leading uncategorised group. */
interface RoleChannelGroup {
    category: CategoryDto | null;
    channels: ChannelDto[];
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
    imports: [NgClass, Tooltip, TranslateModule, ApplyOverrideDialogComponent],
    templateUrl: './role-channels.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoleChannelsComponent {
    readonly guild = input.required<GuildDto>();
    readonly role = input.required<RoleDto>();
    readonly channels = input.required<ChannelDto[]>();
    readonly categories = input.required<CategoryDto[]>();

    private readonly guildService = inject(GuildService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);

    /**
     * The cells this component saved itself, and the role they belong to. `channels` comes from the
     * workspace guild, which is re-pointed on every realtime guild patch and never carries a matrix
     * save back, so a saved cell has to outlive a new `channels` array or it reverts under the user.
     */
    private readonly localEdits = signal<{
        roleId: string;
        cells: ReadonlyMap<string, PermOverride | null>;
    }>({roleId: '', cells: new Map()});

    /** Keyed by channel id, holding only this role's override on that channel. */
    private readonly overrides = computed<ReadonlyMap<string, PermOverride>>(() => {
        const roleId = this.role().id;
        const map = new Map<string, PermOverride>();
        for (const channel of this.channels()) {
            const perm = channel.permissions.find(p => p.roleId === roleId);
            if (perm) map.set(channel.id, toOverride(perm));
        }

        const local = this.localEdits();
        if (local.roleId !== roleId) return map;

        for (const [channelId, override] of local.cells) {
            if (override) map.set(channelId, override);
            else map.delete(channelId);
        }
        return map;
    });

    /** The row that opened the apply dialog; also its source override. Null means the dialog is closed. */
    protected readonly applyChannelId = signal<string | null>(null);
    protected readonly showApplyDialog = signal(false);

    protected readonly applyOverride = computed<PermOverride>(() => {
        const channelId = this.applyChannelId();
        return channelId ? this.overrideFor(channelId) : EMPTY_OVERRIDE;
    });

    /** Every channel but the one the override is being copied from; applying it to itself is not a real target. */
    protected readonly applyTargets = computed<ChannelDto[]>(() => {
        const channelId = this.applyChannelId();
        return this.channels().filter(c => c.id !== channelId);
    });

    /** Uncategorised channels lead, unlabelled, matching the channel list sidebar; each category then gets its own header row. Empty categories are skipped, there is nothing to show under them. */
    protected readonly groups = computed<RoleChannelGroup[]>(() => {
        const channels = this.channels();
        const byPosition = (a: ChannelDto, b: ChannelDto): number => a.position - b.position;

        const groups: RoleChannelGroup[] = [];
        const uncategorized = channels.filter(c => !c.categoryId).sort(byPosition);
        if (uncategorized.length > 0) groups.push({category: null, channels: uncategorized});

        for (const category of [...this.categories()].sort((a, b) => a.position - b.position)) {
            const inCategory = channels.filter(c => c.categoryId === category.id).sort(byPosition);
            if (inCategory.length > 0) groups.push({category, channels: inCategory});
        }

        return groups;
    });

    protected readonly overrideCount = computed(() => this.overrides().size);
    protected readonly totalChannels = computed(() => this.channels().length);

    /** Only the columns this guild's own channel types use, so the grid never clips on types it doesn't have. */
    protected readonly columns = computed<PermissionKey[]>(() =>
        columnsPresent(this.channels().map(c => c.type)),
    );

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
                error: err => this.reportCellError(err),
            });
            return;
        }

        this.guildService
            .upsertChannelRolePermission(channelId, this.role().id, {
                allowPermissions: stringifyPermissions(allow),
                denyPermissions: stringifyPermissions(deny),
            })
            .subscribe({
                next: perm => this.remember(channelId, perm),
                error: err => this.reportCellError(err),
            });
    }

    openApplyDialog(channelId: string): void {
        this.applyChannelId.set(channelId);
        this.showApplyDialog.set(true);
    }

    /** The dialog already wrote the channels it reports succeeded; re-read them rather than guessing what landed. */
    onApplied(result: {succeeded: string[]; failed: string[]}): void {
        const roleId = this.role().id;
        for (const channelId of result.succeeded) {
            this.guildService.getChannel(channelId).subscribe({
                next: channel => {
                    const perm = channel.permissions.find(p => p.roleId === roleId);
                    if (perm) this.remember(channelId, perm);
                    else this.forget(channelId);
                },
            });
        }
        if (result.failed.length > 0) {
            const key =
                result.failed.length === 1
                    ? 'ROLE_CHANNELS.APPLY_PARTIAL_FAILURE_ONE'
                    : 'ROLE_CHANNELS.APPLY_PARTIAL_FAILURE';
            this.toastService.error(this.translate.instant(key, {count: result.failed.length}));
        }
    }

    /** Never left showing the edit as saved: overrides only changes from remember/forget, never optimistically. */
    private reportCellError(err: unknown): void {
        this.toastService.httpError(this.translate.instant('ROLE_CHANNELS.CELL_ERROR'), err);
    }

    private overrideFor(channelId: string): PermOverride {
        return this.overrides().get(channelId) ?? EMPTY_OVERRIDE;
    }

    private remember(channelId: string, perm: ChannelPermission): void {
        this.recordEdit(channelId, toOverride(perm));
    }

    private forget(channelId: string): void {
        this.recordEdit(channelId, null);
    }

    private recordEdit(channelId: string, override: PermOverride | null): void {
        const roleId = this.role().id;
        this.localEdits.update(current => {
            const cells = new Map(current.roleId === roleId ? current.cells : []);
            cells.set(channelId, override);
            return {roleId, cells};
        });
    }
}
