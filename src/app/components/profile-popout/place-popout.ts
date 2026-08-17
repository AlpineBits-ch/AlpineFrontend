export interface Rect {
    left: number;
    right: number;
    top: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface Viewport {
    width: number;
    height: number;
}

export interface Placement {
    left: number;
    top: number;
}

/** Gap between the anchor and the card. */
export const POPOUT_GAP = 8;

/** Smallest distance the card may sit from a viewport edge. */
export const POPOUT_MARGIN = 8;

/**
 * Where to put the popout for a row in a right-hand list: to its left, flipping to the right only
 * when the left side cannot hold it. A card taller than the viewport pins to the top and scrolls
 * internally rather than hanging off the bottom.
 */
export function placePopout(anchor: Rect, card: Size, viewport: Viewport): Placement {
    const onTheLeft = anchor.left - card.width - POPOUT_GAP;
    const onTheRight = anchor.right + POPOUT_GAP;

    let left = onTheLeft;
    if (left < POPOUT_MARGIN) {
        left =
            onTheRight + card.width + POPOUT_MARGIN > viewport.width
                ? Math.max(POPOUT_MARGIN, viewport.width - card.width - POPOUT_MARGIN)
                : onTheRight;
    }

    const lowestTop = viewport.height - card.height - POPOUT_MARGIN;
    const top =
        lowestTop < POPOUT_MARGIN ? POPOUT_MARGIN : Math.min(Math.max(anchor.top, POPOUT_MARGIN), lowestTop);

    return {left, top};
}
