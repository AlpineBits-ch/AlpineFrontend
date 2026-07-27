import {Component, computed, input, output, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {
    PermissionOverrideEditorComponent,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';

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
    imports: [NgClass, Popover, Button, Tooltip, PermissionOverrideEditorComponent],
    templateUrl: './permission-overrides-panel.component.html',
    styleUrl: './permission-overrides-panel.component.css',
})
export class PermissionOverridesPanelComponent {
    entries = input.required<OverrideEntry[]>();
    addable = input.required<OverrideEntry[]>();
    kind = input.required<'role' | 'member'>();
    loading = input(false);

    add = output<string>();
    change = output<{ id: string; override: PermOverride }>();
    save = output<string>();
    delete = output<string>();

    protected selectedId = signal<string | null>(null);
    protected selected = computed<OverrideEntry | null>(() => {
        const list = this.entries();
        if (list.length === 0) return null;
        return list.find(e => e.id === this.selectedId()) ?? list[0];
    });

    @ViewChild('addPopover') private addPopoverRef!: Popover;

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
        return this.kind() === 'role' ? 'Select a role to edit its permissions' : 'Select a member to edit its permissions';
    }

    addableEmptyText(): string {
        return this.kind() === 'role' ? 'All roles have overrides' : 'No more members to add';
    }
}
