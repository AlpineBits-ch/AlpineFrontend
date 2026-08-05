import {Component, computed, HostListener, inject, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ContextMenu} from 'primeng/contextmenu';
import {Tooltip} from 'primeng/tooltip';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {WikiCategoryDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiStateService} from '../wiki-state.service';
import {TranslateModule} from '@ngx-translate/core';

export interface CategoryTreeNode {
    category: WikiCategoryDto;
    depth: number;
}

export interface PageTreeNode {
    page: WikiPageSummaryDto;
    depth: number;
}

@Component({
    selector: 'app-wiki-nav',
    imports: [NgClass, FormsModule, Button, Dialog, InputText, Select, ContextMenu, Tooltip, PrimeTemplate, TranslateModule],
    templateUrl: './wiki-nav.component.html',
})
export class WikiNavComponent {
    protected readonly state = inject(WikiStateService);
    protected ctxMenuItems: MenuItem[] = [];
    protected categoryTreeNodes = computed((): CategoryTreeNode[] => {
        const cats = this.state.wiki()?.categories ?? [];
        const result: CategoryTreeNode[] = [];
        const buildTree = (parentId: string | undefined, depth: number) => {
            const children = cats
                .filter(c => (parentId === undefined ? !c.parentCategoryId : c.parentCategoryId === parentId))
                .sort((a, b) => a.position - b.position);
            for (const child of children) {
                result.push({category: child, depth});
                buildTree(child.id, depth + 1);
            }
        };
        buildTree(undefined, 0);
        return result;
    });
    protected pinnedPages = computed(() =>
        (this.state.wiki()?.pages ?? []).filter(p => p.isPinned),
    );
    protected uncategorizedPageTree = computed((): PageTreeNode[] => {
        const group = (this.state.wiki()?.pages ?? []).filter(x => !x.categoryId);
        return this.buildPageTree(group);
    });
    // ── Category dialog ────────────────────────────────────────────────────────
    protected showCategoryDialog = signal(false);
    protected newCategoryName = signal('');
    protected newCategoryParentId = signal<string | undefined>(undefined);
    protected creatingCategory = signal(false);
    protected parentCategoryOptions = computed(() => [
        {label: 'None (root)', value: undefined},
        ...(this.state.wiki()?.categories ?? [])
            .sort((a, b) => a.position - b.position)
            .map(c => ({label: c.name, value: c.id})),
    ]);
    protected dropTargetId = signal<string | null>(null);
    protected dropPos = signal<'before' | 'after'>('after');
    protected nestTargetId = signal<string | null>(null);
    protected categoryToDelete = signal<WikiCategoryDto | null>(null);
    protected deletingCategory = signal(false);
    private readonly wikiService = inject(WikiService);
    @ViewChild('catCtxMenu') private catCtxMenu?: ContextMenu;
    // ── Drag state ────────────────────────────────────────────────────────────
    private dragging: { type: 'category' | 'page'; id: string } | null = null;
    private nestTimer: ReturnType<typeof setTimeout> | null = null;
    private lastHoverTarget: string | null = null;

    protected goHome(): void {
        this.state.openHome();
    }

    protected goPage(page: WikiPageSummaryDto): void {
        this.state.openPage(page);
    }

    protected newPage(): void {
        this.state.openEditor();
    }

    protected pageTreeForCategory(categoryId: string): PageTreeNode[] {
        const group = (this.state.wiki()?.pages ?? []).filter(x => x.categoryId === categoryId);
        return this.buildPageTree(group);
    }

    protected isPageActive(page: WikiPageSummaryDto): boolean {
        return this.state.wikiView() === 'page' && this.state.selectedPage()?.id === page.id;
    }

    protected onCategoryContextMenu(event: MouseEvent, category: WikiCategoryDto): void {
        event.preventDefault();
        this.ctxMenuItems = [
            {
                label: 'New Page Here',
                icon: 'pi pi-file-plus',
                command: () => {
                    this.state.openEditor(undefined, {categoryId: category.id});
                },
            },
        ];
        this.catCtxMenu?.show(event);
    }

    protected onPageContextMenu(event: MouseEvent, page: WikiPageSummaryDto): void {
        event.preventDefault();
        const items: MenuItem[] = [
            {
                label: 'Add Article Here',
                icon: 'pi pi-file-plus',
                command: () => {
                    this.state.openEditor(undefined, {categoryId: page.categoryId, parentPageId: page.id});
                },
            },
        ];

        this.ctxMenuItems = items;
        this.catCtxMenu?.show(event);
    }

    protected submitCreateCategory(): void {
        const guildId = this.state.guildId();
        if (this.creatingCategory() || !this.newCategoryName().trim() || !guildId) return;
        this.creatingCategory.set(true);
        const parentId = this.newCategoryParentId();
        const siblings = (this.state.wiki()?.categories ?? []).filter(
            c => c.parentCategoryId === parentId,
        );
        this.wikiService
            .createCategory(guildId, {
                name: this.newCategoryName().trim(),
                position: siblings.length,
                parentCategoryId: parentId,
            })
            .subscribe({
                next: () => {
                    this.creatingCategory.set(false);
                    this.showCategoryDialog.set(false);
                    this.newCategoryName.set('');
                    this.newCategoryParentId.set(undefined);
                    this.state.reload();
                },
                error: () => this.creatingCategory.set(false),
            });
    }

    // WebView2 requires dropEffect = 'move' set on every dragover/dragenter.
    @HostListener('document:dragover', ['$event'])
    protected onGlobalDragOver(event: DragEvent): void {
        if (!this.dragging) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    @HostListener('document:dragenter', ['$event'])
    protected onGlobalDragEnter(event: DragEvent): void {
        if (!this.dragging) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    @HostListener('document:drop', ['$event'])
    protected onGlobalDrop(event: DragEvent): void {
        event.preventDefault();
    }

    protected onCategoryDragStart(event: DragEvent, category: WikiCategoryDto): void {
        this.dragging = {type: 'category', id: category.id};
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', category.id);
        }
    }

    protected onPageDragStart(event: DragEvent, page: WikiPageSummaryDto): void {
        this.dragging = {type: 'page', id: page.id};
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', page.id);
        }
    }

    protected onItemDragOver(event: DragEvent, targetId: string): void {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (!this.dragging || this.dragging.id === targetId) return;

        if (this.lastHoverTarget !== targetId) {
            this.lastHoverTarget = targetId;
            this.clearNestTimer();
            this.nestTargetId.set(null);

            if (this.dragging.type === 'page' && this.state.wiki()?.pages.some(p => p.id === targetId)) {
                this.nestTimer = setTimeout(() => {
                    this.nestTargetId.set(targetId);
                    this.dropTargetId.set(null);
                    this.nestTimer = null;
                }, 850);
            }
        }

        if (this.nestTargetId() !== targetId) {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            this.dropTargetId.set(targetId);
            this.dropPos.set(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
        }
    }

    protected onDragEnd(event: DragEvent): void {
        const dragging = this.dragging;
        const nestTarget = this.nestTargetId();
        const targetId = nestTarget ?? this.dropTargetId();
        const pos = this.dropPos();
        this.clearDragState();

        if (!dragging || !targetId) return;
        const wiki = this.state.wiki();
        if (!wiki) return;
        const guildId = this.state.guildId();

        // Nest mode: make dragged page a child of the hovered page
        if (nestTarget && dragging.type === 'page') {
            const draggedPage = wiki.pages.find(p => p.id === dragging.id);
            const targetPage = wiki.pages.find(p => p.id === nestTarget);
            if (draggedPage && targetPage && !this.wouldCreateCycle(draggedPage.id, nestTarget, wiki.pages)) {
                this.movePageToGroup(draggedPage, {
                    categoryId: targetPage.categoryId,
                    parentPageId: nestTarget,
                }, guildId);
            }
            return;
        }

        const targetCategory = wiki.categories.find(c => c.id === targetId);

        if (dragging.type === 'category' && targetCategory) {
            this.reorderCategories(dragging.id, targetId, pos, wiki.categories, guildId);
            return;
        }

        if (dragging.type === 'page') {
            const draggedPage = wiki.pages.find(p => p.id === dragging.id);
            if (!draggedPage) return;

            if (targetCategory) {
                const newCategoryId = pos === 'before' ? null : targetCategory.id;
                this.movePageToGroup(draggedPage, {
                    categoryId: newCategoryId ?? undefined,
                    parentPageId: null
                }, guildId);
                return;
            }

            const targetPage = wiki.pages.find(p => p.id === targetId);
            if (targetPage) {
                const newParentId = targetPage.parentPageId ?? null;
                if (newParentId && this.wouldCreateCycle(draggedPage.id, newParentId, wiki.pages)) return;
                this.movePageToGroup(draggedPage, {
                    categoryId: targetPage.categoryId,
                    parentPageId: newParentId,
                }, guildId);
            }
        }
    }

    protected deleteCategory(category: WikiCategoryDto): void {
        this.categoryToDelete.set(category);
    }

    protected confirmDeleteCategory(): void {
        const guildId = this.state.guildId();
        const category = this.categoryToDelete();
        if (!guildId || !category) return;
        this.deletingCategory.set(true);
        this.wikiService.deleteCategory(guildId, category.id).subscribe({
            next: () => {
                this.deletingCategory.set(false);
                this.categoryToDelete.set(null);
                this.state.reload();
            },
            error: () => this.deletingCategory.set(false),
        });
    }

    private buildPageTree(group: WikiPageSummaryDto[]): PageTreeNode[] {
        const groupIds = new Set(group.map(p => p.id));
        const result: PageTreeNode[] = [];
        // A page is a root if it has no parent, its parent doesn't exist in the group, or it references itself.
        const roots = group.filter(x => !x.parentPageId || !groupIds.has(x.parentPageId) || x.parentPageId === x.id);
        const build = (parentId: string, depth: number) => {
            for (const p of group.filter(x => x.parentPageId === parentId && x.id !== parentId)) {
                result.push({page: p, depth});
                build(p.id, depth + 1);
            }
        };
        for (const root of roots) {
            result.push({page: root, depth: 0});
            build(root.id, 1);
        }
        return result;
    }

    private reorderCategories(
        draggedId: string,
        targetId: string,
        pos: 'before' | 'after',
        categories: WikiCategoryDto[],
        guildId: string,
    ): void {
        const dragged = categories.find(c => c.id === draggedId);
        const target = categories.find(c => c.id === targetId);
        if (!dragged || !target) return;
        // Only reorder within the same parent group
        if ((dragged.parentCategoryId ?? null) !== (target.parentCategoryId ?? null)) return;

        const siblings = categories
            .filter(c => (c.parentCategoryId ?? null) === (dragged.parentCategoryId ?? null))
            .sort((a, b) => a.position - b.position);

        const fromIdx = siblings.findIndex(c => c.id === draggedId);
        if (fromIdx === -1) return;
        const [item] = siblings.splice(fromIdx, 1);
        const toIdx = siblings.findIndex(c => c.id === targetId);
        if (toIdx === -1) return;
        siblings.splice(pos === 'before' ? toIdx : toIdx + 1, 0, item);

        const newPositions = new Map(siblings.map((c, i) => [c.id, i]));
        this.state.updateWikiOptimistic(w => ({
            ...w,
            categories: w.categories.map(c => newPositions.has(c.id) ? {...c, position: newPositions.get(c.id)!} : c),
        }));

        siblings.forEach((c, i) => {
            if (categories.find(orig => orig.id === c.id)?.position !== i) {
                this.wikiService.updateCategory(guildId, c.id, {position: i}).subscribe();
            }
        });
    }

    private movePageToGroup(
        page: WikiPageSummaryDto,
        changes: { categoryId: string | undefined; parentPageId: string | null | undefined },
        guildId: string,
    ): void {
        const sameCategory = (page.categoryId ?? null) === (changes.categoryId ?? null);
        const sameParent = (page.parentPageId ?? null) === (changes.parentPageId ?? null);
        if (sameCategory && sameParent) return;

        // When the category changes, all descendants must follow so they don't become orphans.
        const descendants = sameCategory
            ? []
            : this.collectDescendants(page.id, this.state.wiki()?.pages ?? []);

        this.state.updateWikiOptimistic(w => ({
            ...w,
            pages: w.pages.map(p => {
                if (p.id === page.id) return {
                    ...p,
                    categoryId: changes.categoryId,
                    parentPageId: changes.parentPageId ?? undefined
                };
                if (descendants.some(d => d.id === p.id)) return {...p, categoryId: changes.categoryId};
                return p;
            }),
        }));

        this.wikiService.updatePage(guildId, page.id, {
            categoryId: changes.categoryId ?? null,
            parentPageId: changes.parentPageId ?? null,
        }).subscribe();

        for (const d of descendants) {
            this.wikiService.updatePage(guildId, d.id, {categoryId: changes.categoryId ?? null}).subscribe();
        }
    }

    private collectDescendants(pageId: string, allPages: WikiPageSummaryDto[]): WikiPageSummaryDto[] {
        const result: WikiPageSummaryDto[] = [];
        const collect = (parentId: string) => {
            for (const p of allPages.filter(x => x.parentPageId === parentId && x.id !== parentId)) {
                result.push(p);
                collect(p.id);
            }
        };
        collect(pageId);
        return result;
    }

    // Returns true if making `draggedId`'s parent = `newParentId` would create a cycle.
    private wouldCreateCycle(draggedId: string, newParentId: string, pages: WikiPageSummaryDto[]): boolean {
        if (newParentId === draggedId) return true;
        const parentMap = new Map(pages.map(p => [p.id, p.parentPageId]));
        const visited = new Set<string>();
        let current: string | undefined = newParentId;
        while (current) {
            if (visited.has(current)) break; // existing cycle in data -stop
            visited.add(current);
            const parent = parentMap.get(current);
            if (!parent) break;
            if (parent === draggedId) return true;
            current = parent;
        }
        return false;
    }

    private clearNestTimer(): void {
        if (this.nestTimer) {
            clearTimeout(this.nestTimer);
            this.nestTimer = null;
        }
    }

    private clearDragState(): void {
        this.clearNestTimer();
        this.nestTargetId.set(null);
        this.dragging = null;
        this.dropTargetId.set(null);
        this.dropPos.set('after');
        this.lastHoverTarget = null;
    }
}
