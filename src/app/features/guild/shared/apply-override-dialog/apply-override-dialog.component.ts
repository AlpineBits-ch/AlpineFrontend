import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    model,
    output,
    signal,
} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {Checkbox} from 'primeng/checkbox';
import {RadioButton} from 'primeng/radiobutton';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {CategoryDto, ChannelDto, GuildDto} from '../../../../dtos/response/guild.dto';
import {GuildService, OverridePermissionsDto} from '../../../../services/guild.service';
import {parsePermissions, stringifyPermissions} from '../../../../enums/permissions.enum';
import {parseModulePermissions, stringifyModulePermissions} from '../../../../enums/module-permissions.enum';
import {PermOverride} from '../permission-override-editor/permission-override-editor.component';
import {ApplyMode, ApplyTarget, planApply} from './apply-override.plan';

/** How many channel writes run at once. */
const CONCURRENCY = 4;

@Component({
    selector: 'app-apply-override-dialog',
    imports: [Dialog, Button, Checkbox, RadioButton, FormsModule, TranslateModule],
    templateUrl: './apply-override-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApplyOverrideDialogComponent {
    readonly visible = model.required<boolean>();
    readonly guild = input.required<GuildDto>();
    readonly roleId = input.required<string>();
    readonly override = input.required<PermOverride>();
    readonly channels = input.required<ChannelDto[]>();
    readonly categories = input<CategoryDto[]>([]);

    readonly applied = output<{succeeded: string[]; failed: string[]}>();

    protected readonly mode = signal<ApplyMode>('replace');
    protected readonly selected = signal<ReadonlySet<string>>(new Set());
    protected readonly running = signal(false);
    protected readonly done = signal(0);
    protected readonly lastResult = signal<{succeeded: string[]; failed: string[]} | null>(null);

    private guildService = inject(GuildService);

    protected readonly roleName = computed(
        () => this.guild().roles.find(r => r.id === this.roleId())?.name ?? '',
    );

    protected readonly incomingAllowLabel = computed(() => stringifyPermissions(this.override().allow));
    protected readonly incomingDenyLabel = computed(() => stringifyPermissions(this.override().deny));
    protected readonly incomingAllowModuleLabel = computed(() =>
        stringifyModulePermissions(this.override().allowModule),
    );
    protected readonly incomingDenyModuleLabel = computed(() =>
        stringifyModulePermissions(this.override().denyModule),
    );

    protected readonly uncategorizedChannels = computed(() => this.channels().filter(c => !c.categoryId));

    protected readonly channelsByCategory = computed(() => {
        const channels = this.channels();
        return this.categories().map(category => ({
            category,
            channels: channels.filter(c => c.categoryId === category.id),
        }));
    });

    protected readonly steps = computed(() => {
        const targets: ApplyTarget[] = this.channels()
            .filter(c => this.selected().has(c.id))
            .map(c => ({channelId: c.id, existing: this.existingOverride(c)}));

        return planApply(targets, this.override(), this.mode());
    });

    readonly selectedCount = computed(() => this.selected().size);
    readonly skippedCount = computed(() => this.steps().filter(s => s.skipped).length);
    readonly writeCount = computed(() => this.steps().filter(s => !s.skipped).length);

    protected readonly failedChannelNames = computed(() => {
        const failed = this.lastResult()?.failed ?? [];
        if (failed.length === 0) return [];
        const byId = new Map(this.channels().map(c => [c.id, c.name]));
        return failed.map(id => byId.get(id) ?? id);
    });

    isSelected(channelId: string): boolean {
        return this.selected().has(channelId);
    }

    isFailed(channelId: string): boolean {
        return this.lastResult()?.failed.includes(channelId) ?? false;
    }

    isCategorySelected(categoryId: string): boolean {
        const ids = this.channels()
            .filter(c => c.categoryId === categoryId)
            .map(c => c.id);
        return ids.length > 0 && ids.every(id => this.selected().has(id));
    }

    toggleChannel(channelId: string): void {
        this.selected.update(set => {
            const next = new Set(set);
            if (next.has(channelId)) next.delete(channelId);
            else next.add(channelId);
            return next;
        });
    }

    toggleCategory(categoryId: string): void {
        const ids = this.channels()
            .filter(c => c.categoryId === categoryId)
            .map(c => c.id);
        const allSelected = ids.every(id => this.selected().has(id));

        this.selected.update(set => {
            const next = new Set(set);
            for (const id of ids) {
                if (allSelected) next.delete(id);
                else next.add(id);
            }
            return next;
        });
    }

    setMode(mode: ApplyMode): void {
        this.mode.set(mode);
    }

    async apply(): Promise<{succeeded: string[]; failed: string[]}> {
        if (this.running()) return {succeeded: [], failed: []};

        this.running.set(true);
        this.done.set(0);
        this.lastResult.set(null);

        const queue = this.steps().filter(step => !step.skipped);
        const total = queue.length;
        const succeeded: string[] = [];
        const failed: string[] = [];

        const worker = async (): Promise<void> => {
            for (;;) {
                const step = queue.shift();
                if (!step) return;

                try {
                    await firstValueFrom(
                        this.guildService.upsertChannelRolePermission(
                            step.channelId,
                            this.roleId(),
                            this.body(step.result),
                        ),
                    );
                    succeeded.push(step.channelId);
                } catch {
                    failed.push(step.channelId);
                }

                this.done.update(n => Math.min(n + 1, total));
            }
        };

        await Promise.all(Array.from({length: CONCURRENCY}, worker));

        this.running.set(false);
        const result = {succeeded, failed};
        this.lastResult.set(result);
        this.applied.emit(result);
        return result;
    }

    /** Omitting the module pair tells the server to carry it over; sending 'None' would clear it. */
    private body(result: PermOverride): OverridePermissionsDto {
        const dto: OverridePermissionsDto = {
            allowPermissions: stringifyPermissions(result.allow),
            denyPermissions: stringifyPermissions(result.deny),
        };

        if (result.allowModule !== 0n || result.denyModule !== 0n) {
            dto.allowModulePermissions = stringifyModulePermissions(result.allowModule);
            dto.denyModulePermissions = stringifyModulePermissions(result.denyModule);
        }

        return dto;
    }

    private existingOverride(channel: ChannelDto): PermOverride | null {
        const perm = channel.permissions.find(p => p.roleId === this.roleId());
        if (!perm) return null;
        return {
            allow: parsePermissions(perm.allowPermissions),
            deny: parsePermissions(perm.denyPermissions),
            allowModule: parseModulePermissions(perm.allowModulePermissions ?? 'None'),
            denyModule: parseModulePermissions(perm.denyModulePermissions ?? 'None'),
        };
    }
}
