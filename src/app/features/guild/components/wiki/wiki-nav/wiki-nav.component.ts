import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    HostListener,
    inject,
    Injector,
    NgZone,
    OnDestroy,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {forkJoin, Observable} from 'rxjs';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ContextMenuComponent} from '../../../../../shared/context-menu/context-menu.component';
import {Toast} from 'primeng/toast';
import {Tooltip} from 'primeng/tooltip';
import {MessageService, PrimeTemplate} from 'primeng/api';
import {MenuItem} from '../../../../../shared/context-menu/context-menu.model';
import {WikiCategoryDto, WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {ToastService} from '../../../../../services/toast.service';
import {WikiStateService} from '../wiki-state.service';
import {canEditPage} from '../wiki-permissions';
import {wikiUrl} from '../../../../messaging/wiki-link';
import {narrowNav} from './wiki-nav-filter';
import {WikiNavPrefsService} from './wiki-nav-prefs.service';
import {ancestorCategoryIds, buildNavRows, NavRow} from './wiki-nav-rows';
import {DragSource, DropIntent, dropIntent, DropModel, DropTarget} from './wiki-nav-drop';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

/** How long a delete stays undoable; long enough to notice the toast and react, short enough that a user who walked away doesn't leave the wiki in a half-deleted state. */
const UNDO_WINDOW_MS = 6000;
/** Keyed so this toast lands in the nav's own outlet, not the app-wide one, which has no Undo. */
const UNDO_TOAST_KEY = 'wiki-undo';
/** Dwell before a page-over-page hover gets the full nest emphasis. */
const NEST_DELAY_MS = 850;
const AUTOSCROLL_ZONE_PX = 36;
const AUTOSCROLL_STEP_PX = 12;
const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();

interface PendingRemoval {
    /** The whole wiki as it was before the optimistic removal: the cheapest correct undo. */
    snapshot: WikiDto;
    timer: ReturnType<typeof setTimeout>;
    commit: () => void;
}

@Component({
    selector: 'app-wiki-nav',
    imports: [
        FormsModule,
        Button,
        Dialog,
        InputText,
        Select,
        ContextMenuComponent,
        Toast,
        Tooltip,
        PrimeTemplate,
        TranslateModule,
    ],
    templateUrl: './wiki-nav.component.html',
    styleUrl: './wiki-nav.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WikiNavComponent implements OnDestroy {
    /** A keyboard shortcut nobody can see is not a feature, so the header carries a button too. */
    readonly searchRequested = output<void>();

    protected readonly state = inject(WikiStateService);
    protected readonly prefs = inject(WikiNavPrefsService);

    protected get undoToastKey(): string {
        return UNDO_TOAST_KEY;
    }

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

    protected readonly visiblePages = computed(() => {
        const pages = this.state.wiki()?.pages ?? [];
        const visible = this.narrowed()?.pageIds;
        return visible ? pages.filter(p => visible.has(p.id)) : pages;
    });

    protected readonly visibleCategories = computed(() => {
        const categories = this.state.wiki()?.categories ?? [];
        const visible = this.narrowed()?.categoryIds;
        return visible ? categories.filter(c => visible.has(c.id)) : categories;
    });

    /** Every row the nav draws, in order. One pass; nothing here is recomputed per category. */
    protected readonly rows = computed<NavRow[]>(() =>
        buildNavRows({
            categories: this.visibleCategories(),
            pages: this.visiblePages(),
            allPages: this.state.wiki()?.pages ?? [],
            allCategories: this.state.wiki()?.categories ?? [],
            // A filter that left a category folded would hide its own matches.
            collapsedIds: this.narrowed() ? NO_COLLAPSED : new Set(this.prefs.collapsed()),
            favourites: this.prefs.favourites(),
            recents: this.prefs.recents(),
            canDrag: this.state.abilitiesResolved() && this.state.abilities().canManageStructure,
        }),
    );

    protected readonly activePageId = computed(() =>
        this.state.wikiView() === 'page' ? (this.state.selectedPage()?.id ?? null) : null,
    );

    /** True when a filter is on and it matched nothing anywhere. */
    protected readonly filterEmpty = computed(() => {
        const narrowed = this.narrowed();
        return !!narrowed && narrowed.pageIds.size === 0 && narrowed.categoryIds.size === 0;
    });

    // A failed first load also leaves `wiki` null, and a skeleton that never resolves reads as a hang.
    protected readonly loading = computed(() => this.state.wiki() === null && !this.state.wikiLoadFailed());
    protected readonly skeletonWidths = [88, 64, 76, 58, 82, 60];

    // ── Category dialog ────────────────────────────────────────────────────────
    protected readonly showCategoryDialog = signal(false);
    protected readonly newCategoryName = signal('');
    protected readonly newCategoryParentId = signal<string | undefined>(undefined);
    protected readonly creatingCategory = signal(false);
    protected readonly parentCategoryOptions = computed(() => [
        {label: this.translate.instant('WIKI.NAV.CATEGORY_ROOT'), value: undefined},
        // Copied first: `.sort()` on the signal's own array would reorder the live wiki as a side effect of reading this.
        ...[...(this.state.wiki()?.categories ?? [])]
            .sort((a, b) => a.position - b.position)
            .map(c => ({label: c.name, value: c.id})),
    ]);

    // ── Drag state ────────────────────────────────────────────────────────────
    protected readonly dragging = signal<DragSource | null>(null);
    protected readonly hover = signal<{id: string; intent: DropIntent} | null>(null);
    protected readonly nestTargetId = signal<string | null>(null);

    /** Only category rows can carry one: pages have no position to reorder into. */
    protected readonly insertLine = computed(() => {
        const hover = this.hover();
        if (!hover || hover.intent.kind !== 'reorder') return null;
        return {id: hover.id, position: hover.intent.position ?? 'after'};
    });

    protected readonly dropIntoId = computed(() => {
        const hover = this.hover();
        return hover && (hover.intent.kind === 'into' || hover.intent.kind === 'nest') ? hover.id : null;
    });

    protected readonly refusedId = computed(() => {
        const hover = this.hover();
        return hover && hover.intent.kind === 'none' && hover.intent.reason !== 'self' ? hover.id : null;
    });

    // ── Keyboard ──────────────────────────────────────────────────────────────
    protected readonly focusIndex = signal(0);
    /** The one row in the tab order: the tree is a single tab stop, arrows move within it. */
    protected readonly rovingKey = computed(() => {
        const rows = this.rows();
        const at = rows[this.focusIndex()];
        return (at?.focusable ? at : rows.find(row => row.focusable))?.key ?? null;
    });

    private readonly wikiService = inject(WikiService);
    private readonly translate = inject(TranslateService);
    private readonly toast = inject(ToastService);
    private readonly messageService = inject(MessageService);
    private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
    private readonly injector = inject(Injector);
    private readonly zone = inject(NgZone);

    private readonly rowMenu = viewChild<ContextMenuComponent>('rowMenu');
    private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

    private nestTimer: ReturnType<typeof setTimeout> | null = null;
    private lastHoverTarget: string | null = null;
    private autoScrollDirection = 0;
    private autoScrollFrame: number | null = null;
    private movedToast: Element | null = null;

    /** Only one removal is undoable at a time: a queue would need per-toast dismissal, which PrimeNG's MessageService cannot do (`clear(key)` clears them all), so a second delete commits the first instead of silently stranding it without an Undo. */
    private pending: PendingRemoval | null = null;

    constructor() {
        effect(() => this.prefs.load(this.state.guildId()));

        // Recorded from the selection rather than from this component's own click handler: pages are opened from search, backlinks, breadcrumbs and the home grid too, and a "recently viewed" list that only knew about tree clicks would be wrong most of the time.
        effect(() => {
            const page = this.state.selectedPage();
            if (!page) return;
            // `recordVisit` reads the list it writes; tracking that read makes the effect its own trigger.
            untracked(() => {
                this.prefs.recordVisit(page.id);
                this.reveal(page.id);
            });
        });

        // The nav column is `transform`ed into a drawer below `lg`, which makes it the containing
        // block for anything fixed inside it. The toast has to sit beside the dialog masks instead.
        afterNextRender(() => {
            this.movedToast = this.host.nativeElement.querySelector('p-toast');
            if (this.movedToast) document.body.appendChild(this.movedToast);
        });
    }

    ngOnDestroy(): void {
        // Leaving the wiki must not cancel a delete the user already asked for.
        this.flushPending();
        this.clearDragState();
        this.movedToast?.remove();
        this.movedToast = null;
    }

    protected goHome(): void {
        this.state.openHome();
    }

    protected newPage(): void {
        this.state.openEditor();
    }

    protected retry(): void {
        this.state.reload();
    }

    // ── Rows ──────────────────────────────────────────────────────────────────

    protected onRowClick(row: NavRow): void {
        if (row.category) {
            this.prefs.toggleCollapsed(row.category.id);
            return;
        }
        if (row.page) this.state.openPage(row.page);
    }

    protected onRowFocus(index: number): void {
        this.focusIndex.set(index);
    }

    protected onRowKeydown(event: KeyboardEvent, row: NavRow, index: number): void {
        if (this.renamingId()) return;

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                this.focusRow(this.nextFocusable(index, 1));
                return;
            case 'ArrowUp':
                event.preventDefault();
                this.focusRow(this.nextFocusable(index, -1));
                return;
            case 'Home':
                event.preventDefault();
                this.focusRow(this.nextFocusable(-1, 1));
                return;
            case 'End':
                event.preventDefault();
                this.focusRow(this.nextFocusable(this.rows().length, -1));
                return;
            case 'Enter':
            case ' ':
                event.preventDefault();
                this.onRowClick(row);
                return;
            case 'ContextMenu':
                event.preventDefault();
                this.openRowMenuAt(row);
                return;
        }

        if (event.key === 'F10' && event.shiftKey) {
            event.preventDefault();
            this.openRowMenuAt(row);
            return;
        }

        if (row.category) {
            this.onCategoryKeydown(event, row.category, index);
            return;
        }
        if (row.page) this.onPageKeydown(event, row.page, index);
    }

    /** ArrowDown out of the filter box lands on the first row, so the two feel like one control. */
    protected focusFirstItem(event: Event): void {
        event.preventDefault();
        this.focusRow(this.nextFocusable(-1, 1));
    }

    // ── Context menus ─────────────────────────────────────────────────────────

    protected onRowContextMenu(event: MouseEvent, row: NavRow): void {
        const items = this.menuItemsFor(row);
        if (!items.length) {
            event.preventDefault();
            return;
        }
        this.rowMenu()?.show(event, items);
    }

    /** The pointer-discoverable twin of the context menu, on the row's `...` button. */
    protected openRowMenu(event: MouseEvent, row: NavRow): void {
        event.stopPropagation();
        const items = this.menuItemsFor(row);
        if (items.length) this.rowMenu()?.toggle(event, items);
    }

    private openRowMenuAt(row: NavRow): void {
        const element = this.rowElement(row.key);
        const items = this.menuItemsFor(row);
        if (!element || !items.length) return;
        const rect = element.getBoundingClientRect();
        this.rowMenu()?.show(
            new MouseEvent('contextmenu', {clientX: rect.left + 12, clientY: rect.bottom - 4}),
            items,
        );
    }

    private menuItemsFor(row: NavRow): MenuItem[] {
        if (row.category) return this.categoryMenuItems(row.category);
        if (!row.page) return [];
        const items = this.pageMenuItems(row.page, this.rows().indexOf(row));
        // The old clear button was `opacity-0` and still focusable; this is the same action with an owner.
        if (row.shortcutOf === 'recent') {
            items.push({
                label: this.translate.instant('WIKI.NAV.RECENT_CLEAR'),
                icon: 'pi pi-history',
                command: () => this.prefs.clearRecents(),
            });
        }
        return items;
    }

    private categoryMenuItems(category: WikiCategoryDto): MenuItem[] {
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
                    danger: true,
                    command: () => this.deleteCategory(category),
                },
            );
        }
        // Every entry is gated, so an empty list means this member may do nothing here: showing a blank menu would be worse than showing none.
        return items;
    }

    private pageMenuItems(page: WikiPageSummaryDto, rowIndex: number): MenuItem[] {
        const abilities = this.state.abilities();
        const canEdit = canEditPage(abilities, page.authorId, this.state.ownUserId());
        const items: MenuItem[] = [
            {
                label: this.translate.instant('WIKI.NAV.REVEAL'),
                icon: 'pi pi-crosshairs',
                command: () => this.reveal(page.id, true),
            },
        ];

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
                    danger: true,
                    command: () => this.deletePage(page, rowIndex),
                },
            );
        }
        return items;
    }

    // ── Reveal ────────────────────────────────────────────────────────────────

    /** Un-collapses whatever hides the page, then brings its row into view. */
    protected reveal(pageId: string, focusRow = false): void {
        const wiki = this.state.wiki();
        if (!wiki) return;
        for (const id of ancestorCategoryIds(pageId, wiki.pages, wiki.categories)) {
            if (this.prefs.isCollapsed(id)) this.prefs.toggleCollapsed(id);
        }
        afterNextRender(
            () => {
                const element = this.rowElement(`p:${pageId}`);
                if (!element) return;
                element.scrollIntoView({block: 'nearest'});
                if (focusRow) element.focus({preventScroll: true});
            },
            {injector: this.injector},
        );
    }

    // ── Inline rename ─────────────────────────────────────────────────────────

    protected startRename(id: string, current: string): void {
        this.renamingId.set(id);
        this.renameValue.set(current);
        // The input does not exist until this render lands.
        afterNextRender(
            () => this.host.nativeElement.querySelector<HTMLInputElement>('[data-rename-input]')?.select(),
            {injector: this.injector},
        );
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
    protected deletePage(page: WikiPageSummaryDto, rowIndex = -1): void {
        const guildId = this.state.guildId();
        const snapshot = this.state.wiki();
        if (!guildId || !snapshot) return;

        this.state.updateWikiOptimistic(w => ({...w, pages: w.pages.filter(p => p.id !== page.id)}));
        // Children are left alone: the row builder already treats a page whose parent is missing as a root, so they surface one level up instead of vanishing with the parent.
        if (this.state.selectedPage()?.id === page.id) this.state.openHome();
        this.restoreFocus(rowIndex);

        this.schedule(this.translate.instant('WIKI.NAV.DELETED_PAGE', {title: page.title}), snapshot, () => {
            this.prefs.forget(page.id);
            return this.wikiService.deletePage(guildId, page.id);
        });
    }

    protected deleteCategory(category: WikiCategoryDto, rowIndex = -1): void {
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
        this.restoreFocus(rowIndex);

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

    // WebView2 requires an explicit dropEffect on every dragover and dragenter.
    @HostListener('document:dragover', ['$event'])
    protected onGlobalDragOver(event: DragEvent): void {
        if (!this.dragging()) return;
        event.preventDefault();
        this.applyDropEffect(event);
        this.updateAutoScroll(event.clientY);
    }

    @HostListener('document:dragenter', ['$event'])
    protected onGlobalDragEnter(event: DragEvent): void {
        if (!this.dragging()) return;
        event.preventDefault();
        this.applyDropEffect(event);
    }

    /** A release anywhere but on a row is a cancel, not a move. */
    @HostListener('document:drop', ['$event'])
    protected onGlobalDrop(event: DragEvent): void {
        event.preventDefault();
        this.clearDragState();
    }

    @HostListener('document:dragend')
    protected onGlobalDragEnd(): void {
        this.clearDragState();
    }

    @HostListener('document:keydown.escape')
    protected onGlobalEscape(): void {
        if (this.dragging()) this.clearDragState();
    }

    protected onRowDragStart(event: DragEvent, row: NavRow): void {
        if (!row.draggable) return;
        this.dragging.set({type: row.category ? 'category' : 'page', id: row.id});
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', row.id);
        }
    }

    protected onRowDragOver(event: DragEvent, row: NavRow): void {
        const dragging = this.dragging();
        if (!dragging) return;
        // Left to bubble: the document handler is what keeps autoscroll running over a row.
        event.preventDefault();

        const target: DropTarget | null =
            row.kind === 'category' || row.kind === 'page'
                ? {type: row.kind === 'category' ? 'category' : 'page', id: row.id}
                : null;
        if (!target) {
            this.clearHover();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
            return;
        }

        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const offset = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
        const intent = dropIntent(dragging, target, offset, this.dropModel());
        this.hover.set({id: row.id, intent});
        if (event.dataTransfer) event.dataTransfer.dropEffect = intent.kind === 'none' ? 'none' : 'move';

        if (this.lastHoverTarget !== row.id) {
            this.lastHoverTarget = row.id;
            this.clearNestTimer();
            this.nestTargetId.set(null);
            if (intent.kind === 'nest') {
                this.nestTimer = setTimeout(() => {
                    this.nestTargetId.set(row.id);
                    this.nestTimer = null;
                }, NEST_DELAY_MS);
            }
        }
    }

    protected onRowDrop(event: DragEvent, row: NavRow): void {
        event.preventDefault();
        event.stopPropagation();
        const dragging = this.dragging();
        const hover = this.hover();
        this.clearDragState();
        if (!dragging || !hover || hover.id !== row.id) return;
        this.commitDrop(dragging, row, hover.intent);
    }

    protected onRowDragEnd(): void {
        this.clearDragState();
    }

    /** The pointer left the tree entirely: nothing should still be showing where it would land. */
    protected onScrollerDragLeave(event: DragEvent): void {
        const related = event.relatedTarget as Node | null;
        const scroller = this.scroller()?.nativeElement;
        if (related && scroller?.contains(related)) return;
        this.clearHover();
    }

    private commitDrop(dragging: DragSource, row: NavRow, intent: DropIntent): void {
        const wiki = this.state.wiki();
        const guildId = this.state.guildId();
        if (!wiki || !guildId) return;

        if (intent.kind === 'reorder') {
            this.reorderCategories(dragging.id, row.id, intent.position ?? 'after', wiki.categories, guildId);
            return;
        }

        const dragged = wiki.pages.find(p => p.id === dragging.id);
        if (!dragged) return;

        if (intent.kind === 'into') {
            this.movePageToGroup(dragged, {categoryId: row.id, parentPageId: null}, guildId);
            return;
        }

        if (intent.kind === 'nest' && row.page) {
            this.movePageToGroup(
                dragged,
                {categoryId: row.page.categoryId, parentPageId: row.page.id},
                guildId,
            );
        }
    }

    private dropModel(): DropModel {
        const wiki = this.state.wiki();
        return {categories: wiki?.categories ?? [], pages: wiki?.pages ?? []};
    }

    private applyDropEffect(event: DragEvent): void {
        if (!event.dataTransfer) return;
        const hover = this.hover();
        event.dataTransfer.dropEffect = !hover || hover.intent.kind === 'none' ? 'none' : 'move';
    }

    /** The tree is its own scroll container, so a category off the bottom is unreachable in one gesture without this. */
    private updateAutoScroll(clientY: number): void {
        const scroller = this.scroller()?.nativeElement;
        if (!scroller) return;
        const rect = scroller.getBoundingClientRect();
        this.autoScrollDirection =
            clientY < rect.top + AUTOSCROLL_ZONE_PX ? -1 : clientY > rect.bottom - AUTOSCROLL_ZONE_PX ? 1 : 0;
        if (this.autoScrollDirection !== 0 && this.autoScrollFrame === null) {
            this.zone.runOutsideAngular(() => {
                this.autoScrollFrame = requestAnimationFrame(this.stepAutoScroll);
            });
        }
    }

    private readonly stepAutoScroll = (): void => {
        const scroller = this.scroller()?.nativeElement;
        if (!scroller || !this.autoScrollDirection || !this.dragging()) {
            this.autoScrollFrame = null;
            return;
        }
        scroller.scrollTop += this.autoScrollDirection * AUTOSCROLL_STEP_PX;
        this.autoScrollFrame = requestAnimationFrame(this.stepAutoScroll);
    };

    // ── Keyboard internals ────────────────────────────────────────────────────

    private onCategoryKeydown(event: KeyboardEvent, category: WikiCategoryDto, index: number): void {
        const abilities = this.state.abilities();
        const collapsed = this.rows()[index]?.collapsed ?? false;
        if (event.key === 'ArrowRight' && collapsed) {
            event.preventDefault();
            this.prefs.toggleCollapsed(category.id);
        } else if (event.key === 'ArrowLeft' && !collapsed) {
            event.preventDefault();
            this.prefs.toggleCollapsed(category.id);
        } else if (event.key === 'F2' && abilities.canManageStructure) {
            event.preventDefault();
            this.startRename(category.id, category.name);
        } else if (event.key === 'Delete' && abilities.canManageStructure) {
            event.preventDefault();
            this.deleteCategory(category, index);
        }
    }

    private onPageKeydown(event: KeyboardEvent, page: WikiPageSummaryDto, index: number): void {
        const abilities = this.state.abilities();
        if (event.key === 'F2' && canEditPage(abilities, page.authorId, this.state.ownUserId())) {
            event.preventDefault();
            this.startRename(page.id, page.title);
        } else if (event.key === 'Delete' && abilities.canDelete) {
            event.preventDefault();
            this.deletePage(page, index);
        }
    }

    private nextFocusable(from: number, delta: number): number {
        const rows = this.rows();
        for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
            if (rows[i].focusable) return i;
        }
        return from;
    }

    private focusRow(index: number): void {
        const row = this.rows()[index];
        if (!row) return;
        this.focusIndex.set(index);
        this.rowElement(row.key)?.focus();
    }

    /** After a removal the row is gone; focus falls to `<body>` and the next arrow key jumps to the top. */
    private restoreFocus(index: number): void {
        if (index < 0) return;
        afterNextRender(
            () => {
                const rows = this.rows();
                const at = Math.min(index, rows.length - 1);
                const next = rows[at]?.focusable ? at : this.nextFocusable(at, -1);
                this.focusRow(next);
            },
            {injector: this.injector},
        );
    }

    private rowElement(key: string): HTMLElement | null {
        return this.host.nativeElement.querySelector<HTMLElement>(`[data-row="${key}"]`);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

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

    private clearNestTimer(): void {
        if (this.nestTimer) {
            clearTimeout(this.nestTimer);
            this.nestTimer = null;
        }
    }

    private clearHover(): void {
        this.clearNestTimer();
        this.nestTargetId.set(null);
        this.hover.set(null);
        this.lastHoverTarget = null;
    }

    private clearDragState(): void {
        this.clearHover();
        this.dragging.set(null);
        this.autoScrollDirection = 0;
        if (this.autoScrollFrame !== null) {
            cancelAnimationFrame(this.autoScrollFrame);
            this.autoScrollFrame = null;
        }
    }
}
