import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    output,
    signal,
    ViewChild,
} from '@angular/core';
import {NgClass} from '@angular/common';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {
    EMPTY_OVERRIDE,
    PermissionOverrideEditorComponent,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {BrokenImageService} from '../../../../services/broken-image.service';
import {EffectivePermissionsDto} from '../../../../dtos/response/effective-permissions.dto';
import {PermissionPreset, presetOverride} from '../permission-presets';

export interface OverrideEntry {
    id: string;
    name: string;
    color?: string;
    avatarUrl?: string | null;
    hasOverride: boolean;
    dirty: boolean;
    saving: boolean;
    pinned?: boolean;
    override: PermOverride;
}

@Component({
    selector: 'app-permission-overrides-panel',
    imports: [NgClass, Popover, Button, Tooltip, TranslateModule, PermissionOverrideEditorComponent],
    templateUrl: './permission-overrides-panel.component.html',
    styleUrl: './permission-overrides-panel.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionOverridesPanelComponent {
    readonly entries = input.required<OverrideEntry[]>();
    readonly addable = input.required<OverrideEntry[]>();
    readonly kind = input.required<'role' | 'member'>();
    readonly loading = input(false);
    /** Forwarded to the editor so channel-scoped household groups appear on the right channel. */
    readonly channelType = input<ChannelType | null>(null);
    readonly searchable = input(false);
    readonly hasMore = input(false);
    /** A further page loading, as opposed to the first: spins the "load more" row, not the panel. */
    readonly loadingMore = input(false);
    /** The trace for the selected subject, or null while it is in flight. */
    readonly resolved = input<EffectivePermissionsDto | null>(null);
    /** What the server last stored, keyed by subject id. The trace describes this, not a live edit. */
    readonly savedOverrides = input<Record<string, PermOverride | undefined>>({});
    readonly presets = input<readonly PermissionPreset[]>([]);

    add = output<string>();
    change = output<{id: string; override: PermOverride}>();
    save = output<string>();
    delete = output<string>();
    // Not named `search`: that collides with the native DOM search event and trips no-output-native.
    queryChange = output<string>();
    loadMore = output<void>();
    selectionChange = output<string>();

    protected readonly selectedId = signal<string | null>(null);
    protected readonly selected = computed<OverrideEntry | null>(() => {
        const list = this.entries();
        if (list.length === 0) return null;
        return list.find(e => e.id === this.selectedId()) ?? list[0];
    });

    /** The entry whose preset row is showing, cleared once one is picked or dismissed. */
    protected readonly pendingPresetFor = signal<string | null>(null);

    @ViewChild('addPopover') private addPopoverRef!: Popover;

    private brokenImages = inject(BrokenImageService);

    // The API sends an avatarUrl for every profile, uploaded or not; a URL that already failed to load is the only signal this entry has no avatar. See BrokenImageService.
    protected avatarUrl(entry: OverrideEntry): string | undefined {
        return this.brokenImages.isBroken(entry.avatarUrl) ? undefined : (entry.avatarUrl ?? undefined);
    }

    protected onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    select(id: string): void {
        this.selectedId.set(id);
        this.selectionChange.emit(id);
    }

    protected onSearch(value: string): void {
        this.queryChange.emit(value);
    }

    toggleAddPopover(event: Event): void {
        this.addPopoverRef.toggle(event);
    }

    onAdd(id: string): void {
        this.addPopoverRef.hide();
        this.selectedId.set(id);
        this.add.emit(id);
        this.pendingPresetFor.set(id);
        this.selectionChange.emit(id);
    }

    protected get emptyOverride(): PermOverride {
        return EMPTY_OVERRIDE;
    }

    protected pickPreset(preset: PermissionPreset): void {
        const id = this.pendingPresetFor();
        if (!id) return;
        this.change.emit({id, override: presetOverride(preset)});
        this.pendingPresetFor.set(null);
    }

    protected dismissPresets(): void {
        this.pendingPresetFor.set(null);
    }

    initial(name: string): string {
        return name.charAt(0).toUpperCase();
    }

    sidebarEmptyText(): string {
        return this.kind() === 'role' ? 'No roles in this server' : 'No member overrides yet';
    }

    detailPlaceholderText(): string {
        if (this.entries().length === 0) return this.sidebarEmptyText();
        return this.kind() === 'role'
            ? 'Select a role to edit its permissions'
            : 'Select a member to edit its permissions';
    }

    addableEmptyText(): string {
        return this.kind() === 'role' ? 'All roles have overrides' : 'No more members to add';
    }
}
