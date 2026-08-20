import {ChangeDetectionStrategy, Component, computed, input, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {RoleDto} from '../../../../../../../dtos/response/guild.dto';
import {canReorderRole, isPinnedRole, reorderRoles} from './role-reorder';

/**
 * The permanent role list rail: selection, the new-role affordance, and reordering.
 * Reordering itself (drag or the grip's arrow keys) only ever produces a candidate order;
 * the parent still owns persisting it and rolling back on failure.
 */
@Component({
    selector: 'app-role-rail',
    imports: [NgClass, Button, Tooltip, TranslateModule],
    templateUrl: './role-rail.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoleRailComponent {
    readonly roles = input.required<readonly RoleDto[]>();
    readonly selectedRoleId = input<string | null>(null);
    readonly memberCounts = input<ReadonlyMap<string, number>>(new Map());

    readonly roleSelect = output<RoleDto>();
    readonly newRole = output<void>();
    readonly rolesReordered = output<RoleDto[]>();

    private readonly dragIndex = signal<number | null>(null);
    protected readonly dropIndex = signal<number | null>(null);

    /** The line sits above the target when the role is travelling up, below it when down. */
    protected readonly dropBefore = computed(() => {
        const from = this.dragIndex();
        const to = this.dropIndex();
        return from !== null && to !== null && to < from;
    });

    protected isPinned(role: RoleDto): boolean {
        return isPinnedRole(role);
    }

    protected canMove(index: number, delta: number): boolean {
        return canReorderRole(this.roles(), index, index + delta);
    }

    protected selectRole(role: RoleDto): void {
        this.roleSelect.emit(role);
    }

    protected create(): void {
        this.newRole.emit();
    }

    protected onDragStart(index: number): void {
        this.dragIndex.set(index);
    }

    protected onDragOver(event: DragEvent, index: number): void {
        const from = this.dragIndex();
        if (from === null) return;
        event.preventDefault();
        this.dropIndex.set(canReorderRole(this.roles(), from, index) ? index : null);
    }

    protected onDragEnd(): void {
        this.dragIndex.set(null);
        this.dropIndex.set(null);
    }

    protected onDrop(targetIndex: number): void {
        const fromIndex = this.dragIndex();
        this.dragIndex.set(null);
        this.dropIndex.set(null);
        if (fromIndex === null) return;
        this.commitMove(fromIndex, targetIndex);
    }

    /** Arrow keys on the grip: drag alone is mouse-only, so this is the keyboard route to reordering. */
    protected onGripKeydown(event: KeyboardEvent, index: number): void {
        const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null;
        if (delta === null) return;
        event.preventDefault();
        if (this.canMove(index, delta)) this.commitMove(index, index + delta);
    }

    private commitMove(fromIndex: number, targetIndex: number): void {
        const reordered = reorderRoles(this.roles(), fromIndex, targetIndex);
        if (reordered) this.rolesReordered.emit(reordered);
    }
}
