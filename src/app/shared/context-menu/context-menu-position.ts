export interface Size {
    width: number;
    height: number;
}

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface Viewport {
    width: number;
    height: number;
}

export type OriginX = 'left' | 'right';
export type OriginY = 'top' | 'bottom';

export interface Placement {
    x: number;
    y: number;
    originX: OriginX;
    originY: OriginY;
}

/** Distance a panel keeps from the viewport edge. */
export const VIEWPORT_MARGIN = 8;
/** Gap between a panel and the one that opened it. */
export const SUBMENU_GAP = 2;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Room a panel has before it must scroll internally. */
export function availableHeight(viewport: Viewport, margin = VIEWPORT_MARGIN): number {
    return viewport.height - margin * 2;
}

/** Root menu opened at the pointer. Opens down-right, flips only when that would overflow. */
export function placeAtPoint(
    x: number,
    y: number,
    size: Size,
    viewport: Viewport,
    margin = VIEWPORT_MARGIN,
): Placement {
    const flipX = x + size.width + margin > viewport.width && x - size.width >= margin;
    const flipY = y + size.height + margin > viewport.height && y - size.height >= margin;

    return {
        x: clamp(flipX ? x - size.width : x, margin, viewport.width - size.width - margin),
        y: clamp(flipY ? y - size.height : y, margin, viewport.height - size.height - margin),
        originX: flipX ? 'right' : 'left',
        originY: flipY ? 'bottom' : 'top',
    };
}

/** Menu opened from a trigger element. Sits under it, left edges aligned. */
export function placeBelowAnchor(
    anchor: Box,
    size: Size,
    viewport: Viewport,
    margin = VIEWPORT_MARGIN,
    gap = 4,
): Placement {
    const flipX = anchor.left + size.width + margin > viewport.width;
    const below = anchor.bottom + gap;
    const flipY = below + size.height + margin > viewport.height && anchor.top - size.height - gap >= margin;

    return {
        x: clamp(
            flipX ? anchor.right - size.width : anchor.left,
            margin,
            viewport.width - size.width - margin,
        ),
        y: clamp(
            flipY ? anchor.top - size.height - gap : below,
            margin,
            viewport.height - size.height - margin,
        ),
        originX: flipX ? 'right' : 'left',
        originY: flipY ? 'bottom' : 'top',
    };
}

/**
 * Submenu placement. Horizontal is measured off the parent panel, not the row, so the two
 * panels never overlap; vertical is measured off the row so the first child lines up with it.
 */
export function placeSubmenu(
    panel: Box,
    row: Box,
    panelPadding: number,
    size: Size,
    viewport: Viewport,
    margin = VIEWPORT_MARGIN,
    gap = SUBMENU_GAP,
): Placement {
    const rightEdge = panel.right + gap;
    const leftEdge = panel.left - size.width - gap;
    const fitsRight = rightEdge + size.width + margin <= viewport.width;
    const fitsLeft = leftEdge >= margin;
    const toLeft = !fitsRight && fitsLeft;

    return {
        x: clamp(toLeft ? leftEdge : rightEdge, margin, viewport.width - size.width - margin),
        y: clamp(row.top - panelPadding, margin, viewport.height - size.height - margin),
        originX: toLeft ? 'right' : 'left',
        originY: 'top',
    };
}
