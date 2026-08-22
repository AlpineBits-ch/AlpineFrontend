import {describe, expect, it} from 'vitest';
import {GRID_GAP_PX} from '../../../components/profile-canvas/profile-canvas.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {cellAt, measureGrid, MeasuredRect, rowAt, TileRect} from './canvas-grid-geometry';

function widget(id: string, over: Partial<CanvasWidgetDto> = {}): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
        ...over,
    };
}

const HOST_RECT: MeasuredRect = {left: 0, top: 0, width: 400, height: 400};
const GRID_RECT: MeasuredRect = {left: 0, top: 0, width: 400, height: 400};

// jsdom never lays out CSS grid, so a rendered fixture can only ever produce the all-zero tile
// rects that trigger the fallback. This exercises the measured branch directly with hand-fed,
// deliberately non-uniform rows instead: uniform rows are exactly the condition under which the
// old square-cell formula was accidentally correct.
describe('measureGrid, the measured branch', () => {
    it('a lone 2x2 widget resolves both rows rather than bailing to the fallback', () => {
        const widgets = [widget('a', {w: 2, h: 2})];
        const rectOf = (w: CanvasWidgetDto) => (w.id === 'a' ? {top: 0, height: 240} : null);

        const grid = measureGrid(HOST_RECT, GRID_RECT, 4, 2, widgets, rectOf);

        expect(grid?.columnGap).toBe(GRID_GAP_PX); // The fallback always reports a gap of 0.
        expect(grid?.rowTops).toEqual([0, 120]);
        expect(grid?.rowHeights).toEqual([120, 120]);
    });

    it('two 2x2 widgets side by side both resolve the row they share', () => {
        const widgets = [widget('left', {w: 2, h: 2}), widget('right', {x: 2, w: 2, h: 2})];
        const rectOf = () => ({top: 0, height: 240});

        const grid = measureGrid(HOST_RECT, GRID_RECT, 4, 2, widgets, rectOf);

        expect(grid?.columnGap).toBe(GRID_GAP_PX);
        expect(grid?.rowTops).toEqual([0, 120]);
        expect(grid?.rowHeights).toEqual([120, 120]);
    });

    it("a 2x2 at (0,0) plus a 1x1 at (2,0): row 0 uses the 1x1's exact rect, row 1 the even split", () => {
        const widgets = [widget('tall', {w: 2, h: 2}), widget('short', {x: 2, w: 1, h: 1})];
        const rectOf = (w: CanvasWidgetDto) => {
            if (w.id === 'tall') return {top: 0, height: 300};
            if (w.id === 'short') return {top: 5, height: 90};
            return null;
        };

        const grid = measureGrid(HOST_RECT, GRID_RECT, 4, 2, widgets, rectOf);

        expect(grid?.rowTops).toEqual([5, 150]);
        expect(grid?.rowHeights).toEqual([90, 150]);
    });

    it('resolves a pointer against non-uniform measured rows the way a naive width/columns cell never could', () => {
        const widgets = [widget('r0', {y: 0, h: 1}), widget('r1', {y: 1, h: 1}), widget('r2', {y: 2, h: 1})];
        const rects: Record<string, TileRect> = {
            r0: {top: 0, height: 80},
            r1: {top: 80, height: 90},
            r2: {top: 170, height: 140},
        };
        const rectOf = (w: CanvasWidgetDto) => rects[w.id] ?? null;

        const grid = measureGrid(HOST_RECT, GRID_RECT, 4, 3, widgets, rectOf);

        // A uniform hostRect.width / columns cell (400 / 4 = 100px) would place y=175 in row 1
        // (floor(175 / 100) === 1). The real, non-square rows put it in row 2.
        expect(rowAt(175, grid!.rowTops, grid!.rowHeights)).toBe(2);
    });

    it('falls back to evenly spaced square cells when nothing is measurable, and only then', () => {
        const widgets = [widget('a', {w: 1, h: 1})];

        const noGridRect = measureGrid(HOST_RECT, null, 4, 1, widgets, () => ({top: 0, height: 40}));
        expect(noGridRect).toEqual({
            left: 0,
            columnWidth: 100,
            columnGap: 0,
            rowTops: [0],
            rowHeights: [100],
        });

        // gridRect is present, but nothing covers row 1: still a fallback, not a partial measurement.
        const rowUnmeasurable = measureGrid(HOST_RECT, GRID_RECT, 4, 2, widgets, w =>
            w.id === 'a' ? {top: 0, height: 40} : null,
        );
        expect(rowUnmeasurable?.columnGap).toBe(0);
        expect(rowUnmeasurable?.rowHeights).toEqual([100, 100]);

        // Every row measurable: no fallback.
        const fullyMeasurable = measureGrid(HOST_RECT, GRID_RECT, 4, 1, widgets, w =>
            w.id === 'a' ? {top: 0, height: 40} : null,
        );
        expect(fullyMeasurable?.columnGap).toBe(GRID_GAP_PX);
    });
});

describe('cellAt (pure)', () => {
    it("combines columnAt and rowAt, offsetting x by the grid's own left", () => {
        const grid = {left: 20, columnWidth: 96, columnGap: 8, rowTops: [0, 156], rowHeights: [156, 200]};

        expect(cellAt(20 + 104, 180, grid, 4)).toEqual({x: 1, y: 1});
    });
});
