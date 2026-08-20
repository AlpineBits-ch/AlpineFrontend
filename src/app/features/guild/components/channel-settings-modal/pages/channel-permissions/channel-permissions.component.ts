import {ChangeDetectionStrategy, Component, computed, inject, input, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {
    CategoryDto,
    ChannelDto,
    ChannelPermission,
    GuildDto,
} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {PermissionOverridesComponent} from '../../../../shared/permission-overrides/permission-overrides.component';
import {channelScope} from '../../../../shared/permission-overrides/permission-scope';
import {diffOverrides, isSyncedWithCategory} from '../../../../shared/permission-sync';

@Component({
    selector: 'app-channel-permissions',
    imports: [NgClass, ToggleSwitch, FormsModule, Button, TranslateModule, PermissionOverridesComponent],
    templateUrl: './channel-permissions.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelPermissionsComponent {
    readonly channel = input.required<ChannelDto>();
    readonly guild = input.required<GuildDto>();
    readonly categories = input<CategoryDto[]>([]);

    protected readonly advancedOpen = signal(false);
    protected readonly syncing = signal(false);
    protected readonly diffOpen = signal(false);
    protected readonly overrides = signal<ChannelPermission[] | null>(null);

    private guildService = inject(GuildService);

    protected readonly scope = computed(() => channelScope(this.channel()));

    /** Live overwrites: the signal once anything has saved, the input until then. */
    protected readonly channelOverrides = computed(() => this.overrides() ?? this.channel().permissions);

    readonly category = computed<CategoryDto | null>(
        () => this.categories().find(c => c.id === this.channel().categoryId) ?? null,
    );

    readonly synced = computed(() => {
        const category = this.category();
        if (!category) return false;
        return isSyncedWithCategory(this.channelOverrides(), category.permissions);
    });

    readonly divergingCount = computed(() => {
        const category = this.category();
        if (!category) return 0;
        return diffOverrides(this.channelOverrides(), category.permissions).filter(
            row => row.change !== 'same',
        ).length;
    });

    readonly diffRows = computed(() => {
        const category = this.category();
        if (!category) return [];
        return diffOverrides(this.channelOverrides(), category.permissions).filter(
            row => row.change !== 'same',
        );
    });

    setPrivate(isPrivate: boolean): void {
        this.guildService.updateChannel(this.channel().id, {isPrivate}).subscribe({
            next: updated => this.overrides.set(updated.permissions),
        });
    }

    resync(): void {
        if (this.syncing()) return;
        this.syncing.set(true);
        this.guildService.syncChannelPermissions(this.channel().id).subscribe({
            next: rows => {
                this.overrides.set(rows);
                this.syncing.set(false);
                this.diffOpen.set(false);
            },
            error: () => this.syncing.set(false),
        });
    }

    onOverridesChanged(rows: ChannelPermission[]): void {
        this.overrides.set(rows);
    }

    toggleAdvanced(): void {
        this.advancedOpen.update(open => !open);
    }

    toggleDiff(): void {
        this.diffOpen.update(open => !open);
    }

    nameOf(row: {targetId: string; kind: 'role' | 'member'}): string {
        if (row.kind === 'role') {
            return this.guild().roles.find(r => r.id === row.targetId)?.name ?? row.targetId;
        }
        return row.targetId;
    }
}
