import {ChangeDetectionStrategy, Component, inject, input, output, signal, viewChild} from '@angular/core';
import {NgTemplateOutlet} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {ContextMenuComponent} from '../../../shared/context-menu/context-menu.component';
import {MenuItem} from '../../../shared/context-menu/context-menu.model';
import {FolderNode} from './scene-archive/folder-tree';
import {UNFILED} from '../../../dtos/request/scene.dto';
import {SceneStatus} from '../../../dtos/response/scene.dto';
import {SceneLeaf} from './scene-leaf';

const SCENE_DRAG = 'text/scene-channel-id';
/** Kept apart from the scene type so a folder drop can never be read as a filing. */
const FOLDER_DRAG = 'text/scene-folder-id';

/** Only the colour half of the status table: the dot is a colour, not a chip. */
const DOT_COLOUR: Readonly<Record<SceneStatus, string>> = {
    [SceneStatus.Open]: 'text-text-muted',
    [SceneStatus.Active]: 'text-online',
    [SceneStatus.Paused]: 'text-connecting',
    [SceneStatus.Concluded]: 'text-text-faint',
};

/** Where a sibling group has been reshuffled, so the rest of the rail can be flattened around it. */
interface SiblingSwap {
    parentId: string | null;
    order: FolderNode[];
}

/** A scene the reader wants opened, and where in it. */
export interface SceneOpenRequest {
    channelId: string;
    fromStart: boolean;
}

/**
 * The archive's shelves. Two levels, with ALL and Unfiled always present. It scrolls on its own:
 * thirty folders do not fit beside the results.
 */
@Component({
    selector: 'app-scene-folder-rail',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [NgTemplateOutlet, TranslateModule, ContextMenuComponent],
    templateUrl: './scene-folder-rail.component.html',
    styleUrl: './scene-folder-rail.component.css',
    host: {class: 'flex shrink-0 flex-col gap-0.5'},
})
export class SceneFolderRailComponent {
    // TODO(dominic): the archive can only count a shelf it has opened, until the taxonomy route
    // carries counts. The board's are exact.

    readonly tree = input.required<FolderNode[]>();
    /** null is ALL. `UNFILED` is the bucket for scenes on no shelf. */
    readonly selected = input<string | null>(null);
    readonly canManage = input(false);
    /** Scenes filed on each folder, by folder id. A shelf with no entry simply has none loaded. */
    readonly scenesByFolder = input<Readonly<Record<string, readonly SceneLeaf[]>>>({});
    readonly recent = input<readonly SceneLeaf[]>([]);
    /** Open shelves. The rail does not own this: the host remembers it. */
    readonly expandedIds = input<readonly string[]>([]);
    readonly loadingFolderIds = input<readonly string[]>([]);
    /** Shelves whose page is capped, so their count is a floor. */
    readonly partialFolderIds = input<readonly string[]>([]);
    /** A shelf is not a list. Past this it offers the folder instead. */
    readonly leafCap = input(12);

    readonly picked = output<string | null>();
    /** The folder to create inside, or null for the root. */
    readonly createFolder = output<string | null>();
    readonly renameFolder = output<FolderNode>();
    readonly deleteFolder = output<FolderNode>();
    /** Every folder in the guild, in the order they should now sit. */
    readonly reordered = output<string[]>();
    /** A scene was dropped onto a shelf: the channel id, and where it should land. */
    readonly filed = output<{channelId: string; folderId: string | null}>();
    readonly toggled = output<string>();
    readonly openScene = output<SceneOpenRequest>();
    /** The folder a new scene should be filed on, or null for none. */
    readonly createScene = output<string | null>();
    readonly showAll = output<string>();

    private readonly translate = inject(TranslateService);
    private readonly menu = viewChild<ContextMenuComponent>('folderMenu');

    protected readonly UNFILED = UNFILED;
    protected readonly dragOver = signal<string | null>(null);
    /** The row a folder drag would land against, and which side of it. */
    protected readonly reorderOver = signal<{id: string; after: boolean} | null>(null);
    protected readonly menuItems = signal<MenuItem[]>([]);

    private draggingId: string | null = null;

    // ── Menu ────────────────────────────────────────────────────────────────

    protected openMenu(event: MouseEvent, node: FolderNode): void {
        if (!this.canManage()) return;

        const group = this.siblingsOf(node.folder.id);
        const index = group?.order.findIndex(n => n.folder.id === node.folder.id) ?? -1;

        this.menuItems.set([
            {
                label: this.translate.instant('SCENE.ARCHIVE.NEW_SCENE_HERE'),
                icon: 'pi pi-sparkles',
                command: () => this.createScene.emit(node.folder.id),
            },
            {separator: true},
            {
                label: this.translate.instant('SCENE.ARCHIVE.NEW_FOLDER_HERE'),
                icon: 'pi pi-folder-plus',
                // A child folder cannot hold folders, so "here" means beside it.
                command: () => this.createFolder.emit(node.folder.parentFolderId ?? node.folder.id),
            },
            {
                label: this.translate.instant('SCENE.ARCHIVE.RENAME_FOLDER'),
                icon: 'pi pi-pencil',
                command: () => this.renameFolder.emit(node),
            },
            {separator: true},
            {
                label: this.translate.instant('SCENE.ARCHIVE.MOVE_UP'),
                icon: 'pi pi-arrow-up',
                disabled: index <= 0,
                command: () => this.nudge(node, -1),
            },
            {
                label: this.translate.instant('SCENE.ARCHIVE.MOVE_DOWN'),
                icon: 'pi pi-arrow-down',
                disabled: index === -1 || index >= (group?.order.length ?? 0) - 1,
                command: () => this.nudge(node, 1),
            },
            {separator: true},
            {
                label: this.translate.instant('SCENE.ARCHIVE.DELETE_FOLDER'),
                icon: 'pi pi-trash',
                danger: true,
                command: () => this.deleteFolder.emit(node),
            },
        ]);

        this.menu()?.show(event);
    }

    protected openSceneMenu(event: MouseEvent, leaf: SceneLeaf): void {
        const items: MenuItem[] = [
            {
                label: this.translate.instant('SCENE.ARCHIVE.READ_FROM_START'),
                icon: 'pi pi-book',
                command: () => this.openScene.emit({channelId: leaf.channelId, fromStart: true}),
            },
            {
                label: this.translate.instant('SCENE.ARCHIVE.JUMP_TO_LATEST'),
                icon: 'pi pi-arrow-down',
                command: () => this.openScene.emit({channelId: leaf.channelId, fromStart: false}),
            },
        ];

        if (this.canManage()) {
            items.push(
                {separator: true},
                {
                    label: this.translate.instant('SCENE.ARCHIVE.MOVE_TO_FOLDER'),
                    icon: 'pi pi-folder',
                    items: this.folderTargets(leaf.channelId),
                },
            );
        }

        this.menuItems.set(items);
        this.menu()?.show(event);
    }

    /** Unfiled first, then every folder depth first, as move targets for one scene. */
    private folderTargets(channelId: string): MenuItem[] {
        const targets: MenuItem[] = [
            {
                label: this.translate.instant('SCENE.ARCHIVE.UNFILED'),
                command: () => this.filed.emit({channelId, folderId: null}),
            },
            {separator: true},
        ];

        const walk = (nodes: FolderNode[], parentName: string | null): void => {
            for (const node of nodes) {
                const label = parentName ? `${parentName} / ${node.folder.name}` : node.folder.name;
                targets.push({
                    label: `${node.folder.icon ?? ''} ${label}`.trim(),
                    command: () => this.filed.emit({channelId, folderId: node.folder.id}),
                });
                walk(node.children, node.folder.name);
            }
        };
        walk(this.tree(), null);

        return targets;
    }

    protected isOpen(folderId: string): boolean {
        return this.expandedIds().includes(folderId);
    }

    protected isLoading(folderId: string): boolean {
        return this.loadingFolderIds().includes(folderId);
    }

    protected isPartial(folderId: string): boolean {
        return this.partialFolderIds().includes(folderId);
    }

    protected leavesOf(folderId: string): readonly SceneLeaf[] {
        return (this.scenesByFolder()[folderId] ?? []).slice(0, this.leafCap());
    }

    protected overflowOf(folderId: string): number {
        return Math.max(0, (this.scenesByFolder()[folderId] ?? []).length - this.leafCap());
    }

    protected toggle(folderId: string): void {
        this.toggled.emit(folderId);
    }

    protected open(channelId: string): void {
        this.openScene.emit({channelId, fromStart: false});
    }

    protected dotClass(leaf: SceneLeaf): string {
        return DOT_COLOUR[leaf.status];
    }

    protected onRowKeydown(event: KeyboardEvent, node: FolderNode): void {
        if (!this.canManage()) return;
        if (event.key === 'F2') {
            event.preventDefault();
            this.renameFolder.emit(node);
        } else if (event.key === 'Delete') {
            event.preventDefault();
            this.deleteFolder.emit(node);
        } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            this.nudge(node, event.key === 'ArrowUp' ? -1 : 1);
        }
    }

    // ── Drag and drop ───────────────────────────────────────────────────────

    protected onFolderDragStart(event: DragEvent, node: FolderNode): void {
        if (!this.canManage()) {
            event.preventDefault();
            return;
        }
        this.draggingId = node.folder.id;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(FOLDER_DRAG, node.folder.id);
        }
    }

    protected onDragOver(event: DragEvent, folderId: string | null): void {
        if (!this.canManage()) return;

        if (event.dataTransfer?.types.includes(FOLDER_DRAG)) {
            if (!folderId || folderId === this.draggingId) return;
            event.preventDefault();
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            this.reorderOver.set({id: folderId, after: event.clientY > rect.top + rect.height / 2});
            return;
        }

        event.preventDefault();
        this.dragOver.set(folderId ?? UNFILED);
    }

    protected onDragLeave(): void {
        this.dragOver.set(null);
        this.reorderOver.set(null);
    }

    protected onDragEnd(): void {
        this.draggingId = null;
        this.onDragLeave();
    }

    protected onDrop(event: DragEvent, folderId: string | null): void {
        const after = this.reorderOver()?.id === folderId && !!this.reorderOver()?.after;
        this.onDragLeave();
        if (!this.canManage()) return;
        event.preventDefault();

        const draggedId = event.dataTransfer?.getData(FOLDER_DRAG);
        if (draggedId) {
            this.draggingId = null;
            if (folderId && folderId !== draggedId) this.moveFolder(draggedId, folderId, after);
            return;
        }

        const channelId = event.dataTransfer?.getData(SCENE_DRAG);
        if (channelId) this.filed.emit({channelId, folderId});
    }

    // ── Reordering ──────────────────────────────────────────────────────────

    private moveFolder(draggedId: string, targetId: string, after: boolean): void {
        const from = this.siblingsOf(draggedId);
        const to = this.siblingsOf(targetId);
        // Siblings only. Re-parenting is the editor's parent field.
        if (!from || !to || from.parentId !== to.parentId) return;

        const order = [...from.order];
        const fromIndex = order.findIndex(n => n.folder.id === draggedId);
        if (fromIndex === -1) return;
        const [moved] = order.splice(fromIndex, 1);
        const targetIndex = order.findIndex(n => n.folder.id === targetId);
        if (targetIndex === -1) return;
        order.splice(after ? targetIndex + 1 : targetIndex, 0, moved);

        this.reordered.emit(this.flatten(this.tree(), null, {parentId: from.parentId, order}));
    }

    private nudge(node: FolderNode, delta: number): void {
        const group = this.siblingsOf(node.folder.id);
        if (!group) return;
        const from = group.order.findIndex(n => n.folder.id === node.folder.id);
        const to = from + delta;
        if (from === -1 || to < 0 || to >= group.order.length) return;

        const order = [...group.order];
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);

        this.reordered.emit(this.flatten(this.tree(), null, {parentId: group.parentId, order}));
    }

    private siblingsOf(folderId: string): SiblingSwap | null {
        const roots = this.tree();
        if (roots.some(n => n.folder.id === folderId)) return {parentId: null, order: roots};
        for (const root of roots) {
            if (root.children.some(n => n.folder.id === folderId)) {
                return {parentId: root.folder.id, order: root.children};
            }
        }
        return null;
    }

    /** Every folder id depth-first, with one sibling group swapped for its new order. */
    private flatten(nodes: FolderNode[], parentId: string | null, swap: SiblingSwap): string[] {
        const level = swap.parentId === parentId ? swap.order : nodes;
        const ids: string[] = [];
        for (const node of level) {
            ids.push(node.folder.id);
            ids.push(...this.flatten(node.children, node.folder.id, swap));
        }
        return ids;
    }
}
