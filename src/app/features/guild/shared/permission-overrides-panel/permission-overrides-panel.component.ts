import {Component, computed, inject, input, output, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {
    PermissionOverrideEditorComponent,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {BrokenImageService} from '../../../../services/broken-image.service';

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
})
export class PermissionOverridesPanelComponent {
    readonly entries = input.required<OverrideEntry[]>();
    readonly addable = input.required<OverrideEntry[]>();
    readonly kind = input.required<'role' | 'member'>();
    readonly loading = input(false);
    /** Forwarded to the editor so channel-scoped household groups appear on the right channel. */
    readonly channelType = input<ChannelType | null>(null);

    add = output<string>();
    change = output<{id: string; override: PermOverride}>();
    save = output<string>();
    delete = output<string>();

    protected readonly selectedId = signal<string | null>(null);
    protected readonly selected = computed<OverrideEntry | null>(() => {
        const list = this.entries();
        if (list.length === 0) return null;
        return list.find(e => e.id === this.selectedId()) ?? list[0];
    });

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
    }

    toggleAddPopover(event: Event): void {
        this.addPopoverRef.toggle(event);
    }

    onAdd(id: string): void {
        this.addPopoverRef.hide();
        this.selectedId.set(id);
        this.add.emit(id);
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
