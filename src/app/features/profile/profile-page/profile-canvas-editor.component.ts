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

/**
 * What geometry is known about the rendered grid, in pixels relative to `canvasHost`'s own rect.
 * `columnWidth`/`columnGap` are analytic (the columns really are equal `minmax(0,1fr)` tracks).
 * `rowTops`/`rowHeights` are not: `ProfileCanvasComponent` sets no `grid-auto-rows`, so a row is as
 * tall as its content, and the only way to know that is to measure a tile that starts there.
 */
export interface MeasuredGrid {
    left: number;
    columnWidth: number;
    columnGap: number;
    rowTops: readonly number[];
    rowHeights: readonly number[];
}

/** Tailwind's `gap-2`, matching the gap `ProfileCanvasComponent`'s and `CanvasLatticeComponent`'s
 * own `.grid` both use. A fixed design constant rather than something read back off the DOM: jsdom
 * cannot resolve it either way, since it never lays a grid out. */
export const GRID_GAP_PX = 8;

/** ArrowRight/ArrowDown move forward in reading order, ArrowLeft/ArrowUp move back. */
function arrowDelta(key: string): number {
    if (key === 'ArrowRight' || key === 'ArrowDown') return 1;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return -1;
    return 0;
}

/** Row `r`'s own top, in the same space as `rowTops`/`rowHeights`. Extrapolates past the last
 * measured row using that row's own height, so a drag can still target a row nothing occupies yet. */
export function rowTopAt(r: number, rowTops: readonly number[], rowHeights: readonly number[]): number {
    if (rowTops.length === 0) return 0;
    if (r < rowTops.length) return rowTops[r];
    const last = rowTops.length - 1;
    const height = rowHeights[last] || 1;
    return rowTops[last] + (r - last) * height;
}

/** Inverse of `rowTopAt`: which row contains `offsetY`. Walks measured (top, height) pairs rather
 * than dividing by a uniform cell size, because the real grid's rows are content-sized, not square. */
export function rowAt(offsetY: number, rowTops: readonly number[], rowHeights: readonly number[]): number {
    if (rowTops.length === 0) return 0;
    if (offsetY < rowTops[0]) return 0;

    for (let r = 0; r < rowTops.length; r++) {
        const height = rowHeights[r] || 1;
        if (offsetY < rowTops[r] + height) return r;
    }

    const last = rowTops.length - 1;
    const height = rowHeights[last] || 1;
    return last + 1 + Math.floor((offsetY - (rowTops[last] + height)) / height);
}

/** Columns really are equal `minmax(0,1fr)` tracks, so this stays analytic; only the gap needs
 * subtracting out of the stride. */
export function columnAt(offsetX: number, columnWidth: number, gap: number, columns: number): number {
    const stride = columnWidth + gap;
    if (stride <= 0) return 0;
    return Math.min(Math.max(Math.floor(offsetX / stride), 0), columns - 1);
}

/**
 * The canvas, the lattice, tile selection and the visitor preview. Inserting a widget and picking
 * types both go through CanvasEditorService directly, the same way WidgetPropertiesComponent and
 * WidgetEditorPopoverComponent already reach it for the widgets they edit and delete.
 */
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
    /** External override, for a future caller that wants the lattice on for a reason other than
     * this component's own drag. The grid drag below drives it the rest of the time. */
    readonly dragging = input(false);

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

    // Own-profile check: 'me' always sees every visibility, so this stays a pure read over the
    // canvas already loaded. Nothing here ever calls into CanvasEditorService.
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

    protected readonly showLattice = computed(() => this.dragging() || this.draggingId() !== null);

    // Per-row pixel heights for the lattice, measured off the real grid so its guides land on the
    // same row boundaries the drop math computes rather than an independent square-cell guess.
    protected readonly latticeRowHeights = signal<readonly number[]>([]);

    constructor() {
        // Reaches into ProfileCanvasComponent's own tiles by the data-widget-id contract, since
        // that component takes no dimming input. Every widget stays mounted; only opacity and
        // aria-hidden change, so nothing disappears from the layout or the accessibility tree.
        effect(() => {
            this.syncDimming(this.hiddenWidgetIds());
        });

        // Same contract, for `draggable`: a spacer holds nothing to drag, matching tileSelectable's gate.
        effect(() => {
            this.syncDraggable(this.canvas()?.widgets ?? []);
        });

        // Same contract again, for the lattice: measures the real grid so its guides land on the
        // same row boundaries the drop math computes, not an independent square-cell guess.
        effect(() => {
            this.canvas();
            const rows = this.canvasRowCount();
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

    private syncDimming(hidden: ReadonlySet<string>): void {
        const host = this.canvasHost()?.nativeElement;
        if (!host) return;

        host.querySelectorAll<HTMLElement>('[data-widget-id]').forEach(tile => {
            const id = tile.dataset['widgetId'];
            const dim = !!id && hidden.has(id);
            tile.style.opacity = dim ? '0.4' : '';
            if (dim) tile.setAttribute('aria-hidden', 'false');
            else tile.removeAttribute('aria-hidden');
        });
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

    /**
     * Measures the real grid whenever it can: one tile per row is enough to know that row's own
     * top and height, because `reflow` packs contiguously, so every rendered row has a starter.
     * Falls back to evenly spaced square cells (same as before this measurement existed) only when
     * there is nothing to measure yet, e.g. an empty canvas, or a host with no real layout.
     */
    private measureGrid(): MeasuredGrid | null {
        const host = this.canvasHost()?.nativeElement;
        if (!host) return null;

        const hostRect = host.getBoundingClientRect();
        const columns = this.canvasColumns;
        const rows = this.canvasRowCount();
        const widgets = this.canvas()?.widgets ?? [];

        const anyTile = host.querySelector<HTMLElement>('[data-widget-id]');
        const grid = anyTile?.parentElement;
        const gridRect = grid?.getBoundingClientRect();

        if (gridRect && gridRect.width > 0) {
            const rowTops: number[] = [];
            const rowHeights: number[] = [];
            for (let r = 0; r < rows; r++) {
                const starter = widgets.find(w => w.y === r);
                const el = starter && host.querySelector<HTMLElement>(`[data-widget-id="${starter.id}"]`);
                if (!el || !starter) break; // Missing a row's starter tile: bail to the fallback below.
                const tileRect = el.getBoundingClientRect();
                rowTops.push(tileRect.top - hostRect.top);
                // A starter spanning h > 1 rows reports its own combined height; divide it back
                // down so a tall widget doesn't make its first row look as tall as the whole span.
                rowHeights.push(tileRect.height / starter.h);
            }
            if (rowTops.length === rows) {
                const columnWidth = (gridRect.width - GRID_GAP_PX * (columns - 1)) / columns;
                return {
                    left: gridRect.left - hostRect.left,
                    columnWidth,
                    columnGap: GRID_GAP_PX,
                    rowTops,
                    rowHeights,
                };
            }
        }

        const columnWidth = hostRect.width / columns;
        const rowCount = Math.max(rows, 1);
        return {
            left: 0,
            columnWidth,
            columnGap: 0,
            rowTops: Array.from({length: rowCount}, (_, r) => r * columnWidth),
            rowHeights: Array.from({length: rowCount}, () => columnWidth),
        };
    }

    private cellAt(event: DragEvent, grid: MeasuredGrid): {x: number; y: number} {
        const hostRect = this.canvasHost()?.nativeElement.getBoundingClientRect() ?? {left: 0, top: 0};
        const offsetX = event.clientX - hostRect.left - grid.left;
        const offsetY = event.clientY - hostRect.top;
        return {
            x: columnAt(offsetX, grid.columnWidth, grid.columnGap, this.canvasColumns),
            y: rowAt(offsetY, grid.rowTops, grid.rowHeights),
        };
    }

    private syncDraggable(widgets: readonly CanvasWidgetDto[]): void {
        const host = this.canvasHost()?.nativeElement;
        if (!host) return;

        const byId = new Map(widgets.map(widget => [widget.id, widget]));
        host.querySelectorAll<HTMLElement>('[data-widget-id]').forEach(tile => {
            const widget = byId.get(tile.dataset['widgetId'] ?? '');
            tile.draggable = !!widget && !isSpacer(widget);
        });
    }

    // ── Keyboard parity: everything the drag does, an arrow key does too ────────────────────────

    protected onGridKeydown(event: KeyboardEvent): void {
        const delta = arrowDelta(event.key);
        if (delta === 0) return;

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
    private insertWidget(type: string): void {
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
