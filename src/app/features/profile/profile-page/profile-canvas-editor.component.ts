import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    Injector,
    input,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {
    ProfileCanvasComponent,
    WidgetSelectedEvent,
} from '../../../components/profile-canvas/profile-canvas.component';
import {definitionFor, WIDGET_REGISTRY} from '../../../components/profile-canvas/widget-registry';
import {ContextMenuComponent} from '../../../shared/context-menu/context-menu.component';
import {MenuItem} from '../../../shared/context-menu/context-menu.model';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {CanvasVisibility, CanvasWidgetDto, ProfileCanvasDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, isSpacer} from '../../../models/profile-canvas';
import {WidgetEditorPopoverComponent} from './widget-editor-popover.component';
import {CanvasLatticeComponent} from './canvas-lattice.component';
import {cellAt, MeasuredGrid, measureGrid, rowTopAt, TileRect} from './canvas-grid-geometry';

/** Who the canvas is being previewed as. The owner ('me') is the only one who sees every visibility. */
export type PreviewViewer = 'me' | 'friend' | 'mutual' | 'stranger';

const PREVIEW_VIEWERS: readonly PreviewViewer[] = ['me', 'friend', 'mutual', 'stranger'];

const VIEWER_VISIBILITY: Readonly<Record<PreviewViewer, readonly CanvasVisibility[]>> = {
    me: ['everyone', 'friends', 'mutuals'],
    friend: ['everyone', 'friends'],
    mutual: ['everyone', 'mutuals'],
    stranger: ['everyone'],
};

/** Pixel geometry for the drop indicator, derived from the target cell and the grid's own rect. */
interface DropTarget {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** ArrowRight/ArrowDown move forward in reading order, ArrowLeft/ArrowUp move back. */
function arrowDelta(key: string): number {
    if (key === 'ArrowRight' || key === 'ArrowDown') return 1;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return -1;
    return 0;
}

/** Suggested first widgets for a blank canvas, offered as one-click chips. */
const EMPTY_STATE_SUGGESTIONS: readonly string[] = ['quote', 'photo', 'currently'];

/** The canvas, the lattice, tile selection and the visitor preview. Owner-only: this always renders
 * the account's own canvas, never a visitor's. */
@Component({
    selector: 'app-profile-canvas-editor',
    imports: [
        ProfileCanvasComponent,
        CanvasLatticeComponent,
        WidgetEditorPopoverComponent,
        ContextMenuComponent,
        TranslateModule,
    ],
    templateUrl: './profile-canvas-editor.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileCanvasEditorComponent {
    readonly canvas = input<ProfileCanvasDto>();
    readonly owner = input.required<ProfileDto>();

    private readonly editor = inject(CanvasEditorService);
    private readonly translate = inject(TranslateService);
    private readonly injector = inject(Injector);

    private readonly canvasHost = viewChild<ElementRef<HTMLElement>>('canvasHost');
    private readonly widgetMenu = viewChild.required<ContextMenuComponent>('widgetMenu');

    protected get canvasColumns(): number {
        return CANVAS_COLUMNS;
    }

    // Read from the same normalised widgets the grid itself renders, so the lattice can never
    // claim more rows exist than the canvas actually has.
    protected readonly canvasRowCount = computed(() => {
        const widgets = this.canvas()?.widgets ?? [];
        return widgets.reduce((max, widget) => Math.max(max, widget.y + widget.h), 1);
    });

    protected readonly selectedWidgetId = signal<string | null>(null);
    protected readonly selectedTileEl = signal<HTMLElement | null>(null);
    // Escape hides the popover but leaves selectedWidgetId alone, so the tile stays visibly
    // selected for a keyboard user; only clearSelection() actually deselects.
    private readonly editorHidden = signal(false);

    protected readonly popoverWidget = computed(() => {
        const id = this.selectedWidgetId();
        if (!id || this.editorHidden()) return null;
        return this.canvas()?.widgets.find(widget => widget.id === id) ?? null;
    });

    protected readonly addWidgetItems = computed((): MenuItem[] =>
        WIDGET_REGISTRY.map(definition => ({
            label: this.translate.instant(definition.labelKey),
            icon: 'pi ' + definition.icon,
            disabled: !this.editor.canInsert(definition.type),
            command: () => this.insertWidget(definition.type),
        })),
    );

    protected get emptyStateSuggestions(): readonly string[] {
        return EMPTY_STATE_SUGGESTIONS;
    }

    protected suggestionLabelKey(type: string): string {
        return definitionFor(type)?.labelKey ?? '';
    }

    protected suggestionIcon(type: string): string {
        return definitionFor(type)?.icon ?? '';
    }

    // 'me' always sees every visibility: a pure read over the canvas already loaded, never a call
    // into CanvasEditorService.
    protected readonly previewAs = signal<PreviewViewer>('me');

    protected get previewViewers(): readonly PreviewViewer[] {
        return PREVIEW_VIEWERS;
    }

    protected readonly hiddenWidgetIds = computed(() => {
        const allowed = VIEWER_VISIBILITY[this.previewAs()];
        const widgets = this.canvas()?.widgets ?? [];
        return new Set(
            widgets.filter(widget => !allowed.includes(widget.visibility)).map(widget => widget.id),
        );
    });

    protected readonly hiddenWidgets = computed(() => {
        const hidden = this.hiddenWidgetIds();
        return (this.canvas()?.widgets ?? []).filter(widget => hidden.has(widget.id));
    });

    protected readonly hiddenCount = computed(() => this.hiddenWidgetIds().size);

    // Which tile is under a native HTML5 drag, and where it would land. Both null at rest.
    private readonly draggingId = signal<string | null>(null);
    protected readonly dropTarget = signal<DropTarget | null>(null);

    protected readonly showLattice = computed(() => this.draggingId() !== null);

    // One row beyond the last occupied row while dragging, so moving a tile past the end of the
    // content still has a target to land on.
    private readonly latticeRowCount = computed(() => this.canvasRowCount() + (this.showLattice() ? 1 : 0));

    // Per-row pixel heights for the lattice, measured off the real grid so its guides land on the
    // same row boundaries the drop math computes rather than an independent square-cell guess.
    protected readonly latticeRowHeights = signal<readonly number[]>([]);

    constructor() {
        effect(() => {
            this.canvas();
            const rows = this.latticeRowCount();
            const grid = this.measureGrid();
            this.latticeRowHeights.set(
                grid
                    ? Array.from(
                          {length: rows},
                          (_, r) =>
                              rowTopAt(r + 1, grid.rowTops, grid.rowHeights) -
                              rowTopAt(r, grid.rowTops, grid.rowHeights),
                      )
                    : [],
            );
        });
    }

    protected setPreviewAs(viewer: PreviewViewer): void {
        this.previewAs.set(viewer);
    }

    protected previewViewerKey(viewer: PreviewViewer): string {
        return `PROFILE.CANVAS.EDITOR.PREVIEW_${viewer.toUpperCase()}`;
    }

    protected hiddenWidgetAnnouncement(widget: CanvasWidgetDto): string {
        const type = this.translate.instant(definitionFor(widget.type)?.labelKey ?? '');
        return this.translate.instant('PROFILE.CANVAS.EDITOR.PREVIEW_HIDDEN_WIDGET', {type});
    }

    protected openWidgetMenu(event: MouseEvent): void {
        this.widgetMenu().toggle(event);
    }

    protected onWidgetSelected(event: WidgetSelectedEvent): void {
        if (this.selectedWidgetId() === event.id && !this.editorHidden()) {
            this.clearSelection();
            return;
        }
        this.selectTile(event.id, event.element);
    }

    protected onEditorEscaped(): void {
        this.editorHidden.set(true);
        this.selectedTileEl()?.focus();
    }

    protected onEditorDismissed(): void {
        this.clearSelection();
    }

    protected onEditorDeleted(): void {
        this.clearSelection();
    }

    private clearSelection(): void {
        this.selectedWidgetId.set(null);
        this.selectedTileEl.set(null);
        this.editorHidden.set(false);
    }

    private selectTile(id: string, element: HTMLElement): void {
        this.selectedWidgetId.set(id);
        this.selectedTileEl.set(element);
        this.editorHidden.set(false);
    }

    // ── Grid drag: the drop target is a cell computed from the pointer, never a list index ──────

    protected onGridDragStart(event: DragEvent): void {
        const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-widget-id]');
        const id = tile?.dataset['widgetId'];
        const widget = id ? this.canvas()?.widgets.find(w => w.id === id) : null;
        if (!id || !widget || isSpacer(widget)) {
            event.preventDefault();
            return;
        }
        this.draggingId.set(id);
        event.dataTransfer?.setData('text/plain', id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    }

    protected onGridDragOver(event: DragEvent): void {
        const id = this.draggingId();
        if (!id) return;
        event.preventDefault(); // Or the drop never fires.
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

        const dragged = this.canvas()?.widgets.find(w => w.id === id);
        const grid = this.measureGrid();
        if (!dragged || !grid) return;

        const cell = this.cellAt(event, grid);
        const x = Math.min(Math.max(cell.x, 0), this.canvasColumns - dragged.w);
        const top = rowTopAt(cell.y, grid.rowTops, grid.rowHeights);
        const bottom = rowTopAt(cell.y + dragged.h, grid.rowTops, grid.rowHeights);

        this.dropTarget.set({
            left: grid.left + x * (grid.columnWidth + grid.columnGap),
            top,
            width: dragged.w * grid.columnWidth + (dragged.w - 1) * grid.columnGap,
            height: bottom - top,
        });
    }

    protected onGridDrop(event: DragEvent): void {
        event.preventDefault();
        const id = this.draggingId();
        this.clearDrag();
        if (!id) return;

        const dragged = this.canvas()?.widgets.find(w => w.id === id);
        const grid = this.measureGrid();
        if (!dragged || !grid) return;

        const cell = this.cellAt(event, grid);

        // Dropped back inside the tile's own footprint: nothing moved, so nothing writes.
        if (
            cell.x >= dragged.x &&
            cell.x < dragged.x + dragged.w &&
            cell.y >= dragged.y &&
            cell.y < dragged.y + dragged.h
        ) {
            return;
        }

        this.editor.dropAt(id, cell);
    }

    protected onGridDragEnd(): void {
        this.clearDrag();
    }

    private clearDrag(): void {
        this.draggingId.set(null);
        this.dropTarget.set(null);
    }

    /** Reads what `measureGrid` needs off the live DOM, then hands off to the pure geometry. */
    private measureGrid(): MeasuredGrid | null {
        const host = this.canvasHost()?.nativeElement;
        if (!host) return null;

        const hostRect = host.getBoundingClientRect();
        const anyTile = host.querySelector<HTMLElement>('[data-widget-id]');
        const gridRect = anyTile?.parentElement?.getBoundingClientRect() ?? null;

        const rectOf = (widget: CanvasWidgetDto): TileRect | null => {
            const el = host.querySelector<HTMLElement>(`[data-widget-id="${widget.id}"]`);
            if (!el) return null;
            const tileRect = el.getBoundingClientRect();
            return {top: tileRect.top - hostRect.top, height: tileRect.height};
        };

        return measureGrid(
            hostRect,
            gridRect,
            this.canvasColumns,
            this.canvasRowCount(),
            this.canvas()?.widgets ?? [],
            rectOf,
        );
    }

    private cellAt(event: DragEvent, grid: MeasuredGrid): {x: number; y: number} {
        const hostRect = this.canvasHost()?.nativeElement.getBoundingClientRect() ?? {left: 0, top: 0};
        return cellAt(event.clientX - hostRect.left, event.clientY - hostRect.top, grid, this.canvasColumns);
    }

    // ── Keyboard parity: everything the drag does, an arrow key does too ────────────────────────

    protected onGridKeydown(event: KeyboardEvent): void {
        const delta = arrowDelta(event.key);
        if (delta === 0) return;
        // Otherwise every arrow key inside the host is eaten, dead for scrolling the page,
        // regardless of whether a tile actually owns the keystroke.
        if (!(event.target as HTMLElement).closest('[data-widget-id]')) return;

        const widgets = (this.canvas()?.widgets ?? []).filter(w => !isSpacer(w));
        if (widgets.length === 0) return;
        event.preventDefault();

        const selected = this.selectedWidgetId();
        const modified = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;

        if (modified) {
            if (selected) this.editor.move(selected, delta);
            return;
        }

        const index = selected ? widgets.findIndex(w => w.id === selected) : -1;
        const next = widgets[Math.min(Math.max(index + delta, 0), widgets.length - 1)];
        this.selectTileById(next.id);
    }

    private selectTileById(id: string): void {
        const element = this.canvasHost()?.nativeElement.querySelector<HTMLElement>(
            `[data-widget-id="${id}"]`,
        );
        if (!element) return;
        this.selectTile(id, element);
        element.focus();
    }

    // A spacer never becomes a selectable tile (ProfileCanvasComponent.tileSelectable agrees), so
    // inserting one leaves the selection alone instead of anchoring a popover nothing can open.
    protected insertWidget(type: string): void {
        const inserted = this.editor.insert(type);
        if (!inserted || isSpacer(inserted)) return;

        afterNextRender(
            () => {
                const element = this.canvasHost()?.nativeElement.querySelector<HTMLElement>(
                    `[data-widget-id="${inserted.id}"]`,
                );
                if (!element) return;
                this.selectedWidgetId.set(inserted.id);
                this.selectedTileEl.set(element);
                this.editorHidden.set(false);
            },
            {injector: this.injector},
        );
    }
}
