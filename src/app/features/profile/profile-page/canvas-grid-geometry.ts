import {GRID_GAP_PX} from '../../../components/profile-canvas/profile-canvas.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';

/**
 * What geometry is known about the rendered grid, in pixels relative to the host's own rect.
 * `columnWidth`/`columnGap` are analytic (the columns really are equal `minmax(0,1fr)` tracks).
 * `rowTops`/`rowHeights` are not: a row can grow past its `minmax` floor to fit tall content, and
 * the only way to know that is to measure a tile that starts there.
 */
export interface MeasuredGrid {
    left: number;
    columnWidth: number;
    columnGap: number;
    rowTops: readonly number[];
    rowHeights: readonly number[];
}

/** The subset of a `DOMRect` `measureGrid` needs, so a caller can hand it plain numbers instead. */
export interface MeasuredRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** A widget's own measured rect, in the same coordinate space as `MeasuredGrid.rowTops`. */
export interface TileRect {
    top: number;
    height: number;
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
 * Row `r`'s own top and height: an exact `h === 1` starter's rect if one exists, otherwise an even
 * split across whichever widget's footprint covers the row. Null when no widget covers the row, or
 * its rect could not be measured, signalling the caller to fall back for the whole grid instead.
 */
export function rowGeometryAt(
    r: number,
    widgets: readonly CanvasWidgetDto[],
    rectOf: (widget: CanvasWidgetDto) => TileRect | null,
): TileRect | null {
    const exact = widgets.find(w => w.y === r && w.h === 1);
    const source = exact ?? widgets.find(w => w.y <= r && r < w.y + w.h);
    if (!source) return null;

    const rect = rectOf(source);
    if (!rect || rect.height <= 0) return null;
    if (source.h === 1) return rect;

    const height = rect.height / source.h;
    return {top: rect.top + (r - source.y) * height, height};
}

/**
 * Measures the real grid row by row via `rowGeometryAt`, given the host and grid rects and a way to
 * read a widget's own rect. Falls back to evenly spaced square cells whenever a row is unmeasurable,
 * e.g. an empty canvas or a host with no real layout.
 */
export function measureGrid(
    hostRect: MeasuredRect,
    gridRect: MeasuredRect | null,
    columns: number,
    rows: number,
    widgets: readonly CanvasWidgetDto[],
    rectOf: (widget: CanvasWidgetDto) => TileRect | null,
): MeasuredGrid | null {
    if (gridRect && gridRect.width > 0) {
        const rowTops: number[] = [];
        const rowHeights: number[] = [];
        for (let r = 0; r < rows; r++) {
            const geometry = rowGeometryAt(r, widgets, rectOf);
            if (!geometry) break;
            rowTops.push(geometry.top);
            rowHeights.push(geometry.height);
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

/** Which cell an offset relative to the host's own rect falls in. */
export function cellAt(
    hostOffsetX: number,
    hostOffsetY: number,
    grid: MeasuredGrid,
    columns: number,
): {x: number; y: number} {
    return {
        x: columnAt(hostOffsetX - grid.left, grid.columnWidth, grid.columnGap, columns),
        y: rowAt(hostOffsetY, grid.rowTops, grid.rowHeights),
    };
}
