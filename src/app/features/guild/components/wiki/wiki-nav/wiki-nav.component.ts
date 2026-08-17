import {
    Component,
    computed,
    effect,
    ElementRef,
    HostListener,
    inject,
    OnDestroy,
    output,
    signal,
    ViewChild,
} from '@angular/core';
import {NgClass, NgTemplateOutlet} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {forkJoin, Observable} from 'rxjs';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ContextMenu} from 'primeng/contextmenu';
import {Toast} from 'primeng/toast';
import {Tooltip} from 'primeng/tooltip';
import {MenuItem, MessageService, PrimeTemplate} from 'primeng/api';
import {WikiCategoryDto, WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {ToastService} from '../../../../../services/toast.service';
import {WikiStateService} from '../wiki-state.service';
import {canEditPage} from '../wiki-permissions';
import {wikiUrl} from '../../../../messaging/wiki-link';
import {narrowNav} from './wiki-nav-filter';
import {WikiNavPrefsService} from './wiki-nav-prefs.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

export interface CategoryTreeNode {
    category: WikiCategoryDto;
    depth: number;
}

export interface PageTreeNode {
    page: WikiPageSummaryDto;
    depth: number;
}

/** How long a delete stays undoable; long enough to notice the toast and react, short enough that a user who walked away doesn't leave the wiki in a half-deleted state. */
const UNDO_WINDOW_MS = 6000;
/** Keyed so this toast lands in the nav's own outlet, not the app-wide one, which has no Undo. */
const UNDO_TOAST_KEY = 'wiki-undo';

interface PendingRemoval {
    /** The whole wiki as it was before the optimistic removal: the cheapest correct undo. */
    snapshot: WikiDto;
    timer: ReturnType<typeof setTimeout>;
    commit: () => void;
}

@Component({
    selector: 'app-wiki-nav',
    imports: [
        NgClass,
        NgTemplateOutlet,
        FormsModule,
        Button,
        Dialog,
        InputText,
        Select,
        ContextMenu,
        Toast,
        Tooltip,
        PrimeTemplate,
        TranslateModule,
    ],
    templateUrl: './wiki-nav.component.html',
})
export class WikiNavComponent implements OnDestroy {
    /** A keyboard shortcut nobody can see is not a feature, so the header carries a button too. */
    readonly search = output<void>();

    protected readonly state = inject(WikiStateService);
    protected readonly prefs = inject(WikiNavPrefsService);
    protected readonly undoToastKey = UNDO_TOAST_KEY;
    protected ctxMenuItems: MenuItem[] = [];

    // ── In-place filtering ────────────────────────────────────────────────────
    /** Narrows the tree where it stands. ⌘K navigates away; this one does not. */
    protected readonly filterText = signal('');
    protected readonly narrowed = computed(() =>
        narrowNav(this.state.wiki()?.categories ?? [], this.state.wiki()?.pages ?? [], this.filterText()),
    );

    // ── Inline rename ─────────────────────────────────────────────────────────
    /** Holds a page *or* a category id; the two id spaces do not overlap. */
    protected readonly renamingId = signal<string | null>(null);
    protected readonly renameValue = signal('');

    protected readonly categoryTreeNodes = computed((): CategoryTreeNode[] => {
        const cats = this.state.wiki()?.categories ?? [];
        const visible = this.narrowed()?.categoryIds;
        const result: CategoryTreeNode[] = [];
        const buildTree = (parentId: string | undefined, depth: number) => {
            const children = cats
                .filter(c => (parentId === undefined ? !c.parentCategoryId : c.parentCategoryId === parentId))
                .filter(c => !visible || visible.has(c.id))
                .sort((a, b) => a.position - b.position);
            for (const child of children) {
                result.push({category: child, depth});
                buildTree(child.id, depth + 1);
            }
        };
        buildTree(undefined, 0);
        return result;
    });

    protected readonly pinnedPages = computed(() => this.visiblePages().filter(p => p.isPinned));

    protected readonly favouritePages = computed(() => {
        const byId = new Map(this.visiblePages().map(p => [p.id, p]));
        return this.prefs
            .favourites()
            .map(id => byId.get(id))
            .filter((p): p is WikiPageSummaryDto => !!p);
    });

    /** Favourites are already pinned to the top, so repeating them under Recent is noise. */
    protected readonly recentPages = computed(() => {
        const byId = new Map(this.visiblePages().map(p => [p.id, p]));
        const favourites = new Set(this.prefs.favourites());
        return this.prefs
            .recents()
            .filter(id => !favourites.has(id))
            .map(id => byId.get(id))
            .filter((p): p is WikiPageSummaryDto => !!p)
            .slice(0, 5);
    });

    protected readonly uncategorizedPageTree = computed((): PageTreeNode[] =>
        this.buildPageTree(this.visiblePages().filter(x => !x.categoryId)),
    );

    /** True when a filter is on and it matched nothing anywhere. */
    protected readonly filterEmpty = computed(() => {
        const narrowed = this.narrowed();
        return !!narrowed && narrowed.pageIds.size === 0 && narrowed.categoryIds.size === 0;
    });

    // ── Category dialog ────────────────────────────────────────────────────────
    protected readonly showCategoryDialog = signal(false);
    protected readonly newCategoryName = signal('');
    protected readonly newCategoryParentId = signal<string | undefined>(undefined);
    protected readonly creatingCategory = signal(false);
    protected readonly parentCategoryOptions = computed(() => [
        {label: this.translate.instant('WIKI.NAV.CATEGORY_ROOT'), value: undefined},
        ...(this.state.wiki()?.categories ?? [])
            .sort((a, b) => a.position - b.position)
            .map(c => ({label: c.name, value: c.id})),
    ]);

    protected readonly dropTargetId = signal<string | null>(null);
    protected readonly dropPos = signal<'before' | 'after'>('after');
    protected readonly nestTargetId = signal<string | null>(null);

    private readonly wikiService = inject(WikiService);
    private readonly translate = inject(TranslateService);
    private readonly toast = inject(ToastService);
    private readonly messageService = inject(MessageService);
    private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

    @ViewChild('catCtxMenu') private catCtxMenu?: ContextMenu;

    // ── Drag state ────────────────────────────────────────────────────────────
    private dragging: {type: 'category' | 'page'; id: string} | null = null;
    private nestTimer: ReturnType<typeof setTimeout> | null = null;
    private lastHoverTarget: string | null = null;

    /** Only one removal is undoable at a time: a queue would need per-toast dismissal, which PrimeNG's MessageService cannot do (`clear(key)` clears them all), so a second delete commits the first instead of silently stranding it without an Undo. */
    private pending: PendingRemoval | null = null;

    constructor() {
        effect(() => this.prefs.load(this.state.guildId()));

        // Recorded from the selection rather than from this component's own click handler: pages are opened from search, backlinks, breadcrumbs and the home grid too, and a "recently viewed" list that only knew about tree clicks would be wrong most of the time.
        effect(() => {
            const page = this.state.selectedPage();
            if (page) this.prefs.recordVisit(page.id);
        });
    }

    ngOnDestroy(): void {
        // Leaving the wiki must not cancel a delete the user already asked for.
        this.flushPending();
    }

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
        if (this.isCollapsed(categoryId)) return [];
        return this.buildPageTree(this.visiblePages().filter(x => x.categoryId === categoryId));
    }

    protected isPageActive(page: WikiPageSummaryDto): boolean {
        return this.state.wikiView() === 'page' && this.state.selectedPage()?.id === page.id;
    }

    /** A filter that left a category folded would hide its own matches. */
    protected isCollapsed(categoryId: string): boolean {
        return !this.narrowed() && this.prefs.isCollapsed(categoryId);
    }

    // ── Context menus ─────────────────────────────────────────────────────────

    protected onCategoryContextMenu(event: MouseEvent, category: WikiCategoryDto): void {
        event.preventDefault();
        const abilities = this.state.abilities();
        const items: MenuItem[] = [];

        if (abilities.canCreate) {
            items.push({
                label: this.translate.instant('WIKI.NAV.NEW_PAGE_HERE'),
                icon: 'pi pi-file-plus',
                command: () => this.state.openEditor(undefined, {categoryId: category.id}),
            });
        }
        if (abilities.canManageStructure) {
            items.push(
                {
                    label: this.translate.instant('WIKI.NAV.NEW_SUBCATEGORY'),
                    icon: 'pi pi-folder-plus',
                    command: () => {
                        this.newCategoryParentId.set(category.id);
                        this.showCategoryDialog.set(true);
                    },
                },
                {
                    label: this.translate.instant('WIKI.NAV.RENAME'),
                    icon: 'pi pi-pencil',
                    command: () => this.startRename(category.id, category.name),
                },
                {separator: true},
                {
                    label: this.translate.instant('WIKI.NAV.DELETE_CATEGORY'),
                    icon: 'pi pi-trash',
                    command: () => this.deleteCategory(category),
                },
            );
        }

        // Every entry is gated, so an empty list means this member may do nothing here: showing a blank menu would be worse than showing none.
        if (!items.length) return;
        this.ctxMenuItems = items;
        this.catCtxMenu?.show(event);
    }

    protected onPageContextMenu(event: MouseEvent, page: WikiPageSummaryDto): void {
        event.preventDefault();
        const abilities = this.state.abilities();
        const canEdit = canEditPage(abilities, page.authorId, this.state.ownUserId());
        const items: MenuItem[] = [];

        if (abilities.canCreate) {
            items.push({
                label: this.translate.instant('WIKI.NAV.ADD_ARTICLE_HERE'),
                icon: 'pi pi-file-plus',
                command: () =>
                    this.state.openEditor(undefined, {
                        categoryId: page.categoryId,
                        parentPageId: page.id,
                    }),
            });
        }
        if (canEdit) {
            items.push({
                label: this.translate.instant('WIKI.NAV.RENAME'),
                icon: 'pi pi-pencil',
                command: () => this.startRename(page.id, page.title),
            });
        }
        if (abilities.canCreate) {
            items.push({
                label: this.translate.instant('WIKI.NAV.DUPLICATE'),
                icon: 'pi pi-copy',
                command: () => this.duplicatePage(page),
            });
        }
        // Pinning shows the page in everyone's tree, so it is structure; an author who may edit their own page is trusted with it too.
        if (abilities.canManageStructure || canEdit) {
            items.push({
                label: this.translate.instant(page.isPinned ? 'WIKI.NAV.UNPIN' : 'WIKI.NAV.PIN'),
                icon: page.isPinned ? 'pi pi-bookmark' : 'pi pi-bookmark-fill',
                command: () => this.togglePin(page),
            });
        }
        // Favourites and links are local or read-only, so they need no permission at all.
        items.push(
            {
                label: this.translate.instant(
                    this.prefs.isFavourite(page.id) ? 'WIKI.NAV.UNFAVOURITE' : 'WIKI.NAV.FAVOURITE',
                ),
                icon: 'pi pi-star',
                command: () => this.prefs.toggleFavourite(page.id),
            },
            {
                label: this.translate.instant('WIKI.NAV.COPY_LINK'),
                icon: 'pi pi-link',
                command: () => this.copyPageLink(page),
            },
        );
        if (abilities.canDelete) {
            items.push(
                {separator: true},
                {
                    label: this.translate.instant('WIKI.DELETE'),
                    icon: 'pi pi-trash',
                    command: () => this.deletePage(page),
                },
            );
        }

        if (!items.length) return;
        this.ctxMenuItems = items;
        this.catCtxMenu?.show(event);
    }

    // ── Inline rename ─────────────────────────────────────────────────────────

    protected startRename(id: string, current: string): void {
        this.renamingId.set(id);
        this.renameValue.set(current);
        // The input does not exist until this render lands.
        setTimeout(() => {
            this.host.nativeElement.querySelector<HTMLInputElement>('[data-rename-input]')?.select();
        }, 0);
    }

    protected cancelRename(): void {
        this.renamingId.set(null);
        this.renameValue.set('');
    }

    /** Commits on Enter and on blur, and is a no-op the second time: Enter clears `renamingId`, which removes the input, which fires blur. */
    protected commitRename(): void {
        const id = this.renamingId();
        const name = this.renameValue().trim();
        if (!id) return;
        this.renamingId.set(null);
        this.renameValue.set('');

        const guildId = this.state.guildId();
        const snapshot = this.state.wiki();
        if (!guildId || !snapshot || !name) return;

        const page = snapshot.pages.find(p => p.id === id);
        if (page) {
            if (page.title === name) return;
            this.state.updateWikiOptimistic(w => ({
                ...w,
                pages: w.pages.map(p => (p.id === id ? {...p, title: name} : p)),
            }));
            this.withRevert(
                this.wikiService.updatePage(guildId, id, {title: name}),
                snapshot,
                'WIKI.NAV.RENAME_FAILED',
            );
            return;
        }

        const category = snapshot.categories.find(c => c.id === id);
        if (category && category.name !== name) {
            this.state.updateWikiOptimistic(w => ({
                ...w,
                categories: w.categories.map(c => (c.id === id ? {...c, name} : c)),
            }));
            this.withRevert(
                this.wikiService.updateCategory(guildId, id, {name}),
                snapshot,
                'WIKI.NAV.RENAME_FAILED',
            );
        }
    }

    // ── Page actions ──────────────────────────────────────────────────────────

    protected togglePin(page: WikiPageSummaryDto): void {
        const guildId = this.state.guildId();
        const snapshot = this.state.wiki();
        if (!guildId || !snapshot) return;
        const isPinned = !page.isPinned;
        this.state.updateWikiOptimistic(w => ({
            ...w,
            pages: w.pages.map(p => (p.id === page.id ? {...p, isPinned} : p)),
        }));
        this.withRevert(
            this.wikiService.updatePage(guildId, page.id, {isPinned}),
            snapshot,
            'WIKI.NAV.PIN_FAILED',
        );
    }

    /** Needs the body, which the summary does not carry, so it is a fetch then a create. */
    protected duplicatePage(page: WikiPageSummaryDto): void {
        const guildId = this.state.guildId();
        if (!guildId) return;
        this.wikiService.getPage(guildId, page.id).subscribe({
            next: full =>
                this.wikiService
                    .createPage(guildId, {
                        title: this.translate.instant('WIKI.NAV.COPY_OF', {title: full.title}),
                        content: full.content,
                        categoryId: full.categoryId,
                        parentPageId: full.parentPageId,
                        tags: full.tags,
                        visibility: full.visibility,
                    })
                    .subscribe({
                        next: () => this.state.reload(),
                        error: () => this.toast.error(this.translate.instant('WIKI.NAV.DUPLICATE_FAILED')),
                    }),
            error: () => this.toast.error(this.translate.instant('WIKI.NAV.DUPLICATE_FAILED')),
        });
    }

    protected copyPageLink(page: WikiPageSummaryDto): void {
        // The absolute URL, not the `wiki:<id>` markdown form: that form resolves only inside the editor. Pasting into another wiki page still produces an internal link; the editor recognises its own guild's URLs and converts them back (see `wikiUrlToHref`).
        const guildId = this.state.guildId();
        if (!guildId) return;
        void navigator.clipboard.writeText(wikiUrl(guildId, page.id)).then(
            () => this.toast.success(this.translate.instant('WIKI.NAV.LINK_COPIED')),
            // Refused in insecure contexts and when the permission is denied.
            () => this.toast.error(this.translate.instant('WIKI.NAV.LINK_COPY_FAILED')),
        );
    }

    // ── Undoable removal ──────────────────────────────────────────────────────

    /** Removes the page now and asks the server in a few seconds; only the undo path, not a confirm dialog, catches a mistaken delete. */
    protected deletePage(page: WikiPageSummaryDto): void {
        const guildId = this.state.guildId();
        const snapshot = this.state.wiki();
        if (!guildId || !snapshot) return;

        this.state.updateWikiOptimistic(w => ({...w, pages: w.pages.filter(p => p.id !== page.id)}));
        // Children are left alone: `buildPageTree` already treats a page whose parent is missing as a root, so they surface one level up instead of vanishing with the parent.
        if (this.state.selectedPage()?.id === page.id) this.state.openHome();

        this.schedule(this.translate.instant('WIKI.NAV.DELETED_PAGE', {title: page.title}), snapshot, () => {
            this.prefs.forget(page.id);
            return this.wikiService.deletePage(guildId, page.id);
        });
    }

    protected deleteCategory(category: WikiCategoryDto): void {
        const guildId = this.state.guildId();
        const snapshot = this.state.wiki();
        if (!guildId || !snapshot) return;

        this.state.updateWikiOptimistic(w => ({
            ...w,
            categories: w.categories
                .filter(c => c.id !== category.id)
                .map(c => (c.parentCategoryId === category.id ? {...c, parentCategoryId: undefined} : c)),
            // Matches what the server does: the pages survive, uncategorized.
            pages: w.pages.map(p => (p.categoryId === category.id ? {...p, categoryId: undefined} : p)),
        }));

        this.schedule(
            this.translate.instant('WIKI.NAV.DELETED_CATEGORY', {name: category.name}),
            snapshot,
            () => {
                this.prefs.forget(category.id);
                return this.wikiService.deleteCategory(guildId, category.id);
            },
        );
    }

    protected undoPending(): void {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending = null;
        this.state.updateWikiOptimistic(() => pending.snapshot);
        this.messageService.clear(UNDO_TOAST_KEY);
    }

    // ── Keyboard navigation ───────────────────────────────────────────────────

    /** Roving focus over whatever `[data-nav-item]` rows happen to be rendered, driven off the DOM rather than an index into a model: the rows come from five separate sections, and keeping a flat index in sync with all of them would be a second tree to maintain. */
    protected onTreeKeydown(event: KeyboardEvent): void {
        if (this.renamingId()) return;
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-nav-item]'));
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next: number;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (current === -1) next = 0;
        else if (event.key === 'ArrowDown') next = Math.min(current + 1, items.length - 1);
        else next = Math.max(current - 1, 0);
        event.preventDefault();
        items[next]?.focus();
    }

    protected onPageKeydown(event: KeyboardEvent, page: WikiPageSummaryDto): void {
        const abilities = this.state.abilities();
        if (event.key === 'F2' && canEditPage(abilities, page.authorId, this.state.ownUserId())) {
            event.preventDefault();
            this.startRename(page.id, page.title);
        } else if (event.key === 'Delete' && abilities.canDelete) {
            event.preventDefault();
            this.deletePage(page);
        }
    }

    protected onCategoryKeydown(event: KeyboardEvent, category: WikiCategoryDto): void {
        const abilities = this.state.abilities();
        if (event.key === 'ArrowRight' && this.isCollapsed(category.id)) {
            event.preventDefault();
            this.prefs.toggleCollapsed(category.id);
        } else if (event.key === 'ArrowLeft' && !this.isCollapsed(category.id)) {
            event.preventDefault();
            this.prefs.toggleCollapsed(category.id);
        } else if (event.key === 'F2' && abilities.canManageStructure) {
            event.preventDefault();
            this.startRename(category.id, category.name);
        } else if (event.key === 'Delete' && abilities.canManageStructure) {
            event.preventDefault();
            this.deleteCategory(category);
        }
    }

    /** ArrowDown out of the filter box lands on the first row, so the two feel like one control. */
    protected focusFirstItem(event: Event): void {
        event.preventDefault();
        this.host.nativeElement.querySelector<HTMLElement>('[data-nav-item]')?.focus();
    }

    // ── Category creation ─────────────────────────────────────────────────────

    /** Resets the parent, which "New subcategory" may have left pointing somewhere. */
    protected openCategoryDialog(): void {
        this.newCategoryParentId.set(undefined);
        this.showCategoryDialog.set(true);
    }

    protected submitCreateCategory(): void {
        const guildId = this.state.guildId();
        if (this.creatingCategory() || !this.newCategoryName().trim() || !guildId) return;
        this.creatingCategory.set(true);
        const parentId = this.newCategoryParentId();
        const siblings = (this.state.wiki()?.categories ?? []).filter(c => c.parentCategoryId === parentId);
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
                error: () => {
                    this.creatingCategory.set(false);
                    this.toast.error(this.translate.instant('WIKI.NAV.CREATE_CATEGORY_FAILED'));
                },
            });
    }

    // ── Drag and drop ─────────────────────────────────────────────────────────

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
                this.movePageToGroup(
                    draggedPage,
                    {
                        categoryId: targetPage.categoryId,
                        parentPageId: nestTarget,
                    },
                    guildId,
                );
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
                this.movePageToGroup(
                    draggedPage,
                    {
                        categoryId: newCategoryId ?? undefined,
                        parentPageId: null,
                    },
                    guildId,
                );
                return;
            }

            const targetPage = wiki.pages.find(p => p.id === targetId);
            if (targetPage) {
                const newParentId = targetPage.parentPageId ?? null;
                if (newParentId && this.wouldCreateCycle(draggedPage.id, newParentId, wiki.pages)) return;
                this.movePageToGroup(
                    draggedPage,
                    {
                        categoryId: targetPage.categoryId,
                        parentPageId: newParentId,
                    },
                    guildId,
                );
            }
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private visiblePages(): WikiPageSummaryDto[] {
        const pages = this.state.wiki()?.pages ?? [];
        const visible = this.narrowed()?.pageIds;
        return visible ? pages.filter(p => visible.has(p.id)) : pages;
    }

    private buildPageTree(group: WikiPageSummaryDto[]): PageTreeNode[] {
        const groupIds = new Set(group.map(p => p.id));
        const result: PageTreeNode[] = [];
        // A page is a root if it has no parent, its parent doesn't exist in the group, or it references itself.
        const roots = group.filter(
            x => !x.parentPageId || !groupIds.has(x.parentPageId) || x.parentPageId === x.id,
        );
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

        const snapshot = this.state.wiki();
        if (!snapshot) return;

        const newPositions = new Map(siblings.map((c, i) => [c.id, i]));
        this.state.updateWikiOptimistic(w => ({
            ...w,
            categories: w.categories.map(c =>
                newPositions.has(c.id) ? {...c, position: newPositions.get(c.id)!} : c,
            ),
        }));

        const writes = siblings
            .map((c, i) => ({category: c, position: i}))
            .filter(
                ({category, position}) =>
                    categories.find(orig => orig.id === category.id)?.position !== position,
            )
            .map(({category, position}) => this.wikiService.updateCategory(guildId, category.id, {position}));
        if (!writes.length) return;
        this.withRevert(forkJoin(writes), snapshot, 'WIKI.NAV.REORDER_FAILED');
    }

    private movePageToGroup(
        page: WikiPageSummaryDto,
        changes: {categoryId: string | undefined; parentPageId: string | null | undefined},
        guildId: string,
    ): void {
        const sameCategory = (page.categoryId ?? null) === (changes.categoryId ?? null);
        const sameParent = (page.parentPageId ?? null) === (changes.parentPageId ?? null);
        if (sameCategory && sameParent) return;

        const snapshot = this.state.wiki();
        if (!snapshot) return;

        // When the category changes, all descendants must follow so they don't become orphans.
        const descendants = sameCategory ? [] : this.collectDescendants(page.id, snapshot.pages);

        this.state.updateWikiOptimistic(w => ({
            ...w,
            pages: w.pages.map(p => {
                if (p.id === page.id)
                    return {
                        ...p,
                        categoryId: changes.categoryId,
                        parentPageId: changes.parentPageId ?? undefined,
                    };
                if (descendants.some(d => d.id === p.id)) return {...p, categoryId: changes.categoryId};
                return p;
            }),
        }));

        const writes: Observable<unknown>[] = [
            this.wikiService.updatePage(guildId, page.id, {
                categoryId: changes.categoryId ?? null,
                parentPageId: changes.parentPageId ?? null,
            }),
            ...descendants.map(d =>
                this.wikiService.updatePage(guildId, d.id, {categoryId: changes.categoryId ?? null}),
            ),
        ];
        this.withRevert(forkJoin(writes), snapshot, 'WIKI.NAV.MOVE_FAILED');
    }

    /** Runs an optimistic write and puts the tree back if the server refuses; restores the snapshot instead of reloading, since `getWiki` swallows errors into an empty wiki and a failed reload would replace a wrong tree with no tree at all. */
    private withRevert(
        request: Observable<unknown>,
        snapshot: WikiDto,
        messageKey: string,
        onSuccess?: () => void,
    ): void {
        request.subscribe({
            next: () => onSuccess?.(),
            error: () => {
                this.state.updateWikiOptimistic(() => snapshot);
                this.toast.error(this.translate.instant(messageKey));
            },
        });
    }

    /** Arms the undo window; `request` is only built when the delete actually commits, so an undone delete never reaches the network. */
    private schedule(summary: string, snapshot: WikiDto, request: () => Observable<unknown>): void {
        // One at a time: see the note on `pending`.
        this.flushPending();

        const commit = () => {
            this.pending = null;
            // Resynced only once the server has agreed: reloading alongside the request would race it and hand back the row that is being deleted.
            this.withRevert(request(), snapshot, 'WIKI.NAV.DELETE_FAILED', () => this.state.reload());
        };
        this.pending = {snapshot, commit, timer: setTimeout(commit, UNDO_WINDOW_MS)};
        this.messageService.add({
            key: UNDO_TOAST_KEY,
            severity: 'info',
            summary,
            life: UNDO_WINDOW_MS,
        });
    }

    private flushPending(): void {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending = null;
        pending.commit();
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
            if (visited.has(current)) break; // existing cycle in data, stop
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
