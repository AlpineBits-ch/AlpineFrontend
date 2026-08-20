import {describe, expect, it} from 'vitest';
import {
    Box,
    placeAtPoint,
    placeBelowAnchor,
    placeSubmenu,
    Size,
    VIEWPORT_MARGIN,
    Viewport,
} from './context-menu-position';

const VIEWPORT: Viewport = {width: 1000, height: 800};
const MENU: Size = {width: 220, height: 300};

function box(left: number, top: number, width: number, height: number): Box {
    return {left, top, right: left + width, bottom: top + height};
}

describe('placeAtPoint', () => {
    it('opens down-right from the pointer when there is room', () => {
        expect(placeAtPoint(120, 90, MENU, VIEWPORT)).toEqual({
            x: 120,
            y: 90,
            originX: 'left',
            originY: 'top',
        });
    });

    it('flips left rather than spilling past the right edge', () => {
        const placement = placeAtPoint(950, 90, MENU, VIEWPORT);

        expect(placement.x).toBe(730);
        expect(placement.originX).toBe('right');
    });

    it('flips up rather than spilling past the bottom edge', () => {
        const placement = placeAtPoint(120, 700, MENU, VIEWPORT);

        expect(placement.y).toBe(400);
        expect(placement.originY).toBe('bottom');
    });

    it('clamps a panel too wide to flip so its far edge lands on the margin', () => {
        const wide: Size = {width: 900, height: 300};
        const placement = placeAtPoint(700, 90, wide, VIEWPORT);

        expect(placement.x).toBe(VIEWPORT.width - wide.width - VIEWPORT_MARGIN);
        expect(placement.originX).toBe('left');
    });

    it('never places a panel taller than the viewport above the top margin', () => {
        const tall: Size = {width: 220, height: 900};
        const placement = placeAtPoint(120, 400, tall, VIEWPORT);

        expect(placement.y).toBe(VIEWPORT_MARGIN);
    });
});

describe('placeBelowAnchor', () => {
    it('sits under the trigger with left edges aligned', () => {
        const placement = placeBelowAnchor(box(100, 40, 32, 32), MENU, VIEWPORT);

        expect(placement).toEqual({x: 100, y: 76, originX: 'left', originY: 'top'});
    });

    it('right-aligns to the trigger when a left-aligned panel would overflow', () => {
        const placement = placeBelowAnchor(box(900, 40, 32, 32), MENU, VIEWPORT);

        expect(placement.x).toBe(712);
        expect(placement.originX).toBe('right');
    });

    it('opens upward when there is no room below', () => {
        const placement = placeBelowAnchor(box(100, 700, 32, 32), MENU, VIEWPORT);

        expect(placement.y).toBe(396);
        expect(placement.originY).toBe('bottom');
    });
});

describe('placeSubmenu', () => {
    const panel = box(100, 100, 220, 300);
    const row = box(105, 200, 210, 31);
    const sub: Size = {width: 180, height: 160};

    it('clears the parent panel rather than overlapping it', () => {
        const placement = placeSubmenu(panel, row, 5, sub, VIEWPORT);

        expect(placement.x).toBeGreaterThanOrEqual(panel.right);
        expect(placement.originX).toBe('left');
    });

    it('lines the first child row up with the row that opened it', () => {
        expect(placeSubmenu(panel, row, 5, sub, VIEWPORT).y).toBe(195);
    });

    it('opens to the left when the right side has no room', () => {
        const nearEdge = box(760, 100, 220, 300);
        const placement = placeSubmenu(nearEdge, box(765, 200, 210, 31), 5, sub, VIEWPORT);

        expect(placement.x).toBe(578);
        expect(placement.originX).toBe('right');
    });

    it('stays on the right when neither side fits, so it never lands under its parent', () => {
        const narrow: Viewport = {width: 420, height: 800};
        const placement = placeSubmenu(box(100, 100, 220, 300), box(105, 200, 210, 31), 5, sub, narrow);

        expect(placement.originX).toBe('left');
        expect(placement.x).toBe(232);
    });

    it('pulls a tall submenu up so its bottom stays inside the viewport', () => {
        const tall: Size = {width: 180, height: 600};
        const placement = placeSubmenu(panel, box(105, 700, 210, 31), 5, tall, VIEWPORT);

        expect(placement.y).toBe(192);
    });
});
