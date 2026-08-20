import {DestroyRef, inject} from '@angular/core';

/**
 * Anchoring for the editor's floating surfaces.
 *
 * Two halves that are deliberately separable: {@link anchorTo} is arithmetic over a rect and a
 * size, and {@link WikiFloatingController} owns the listeners that decide when to ask for the
 * arithmetic again. A menu that sets `top` straight from a caret coordinate has no flip, no clamp
 * and no answer to a scroll, which is what put the slash menu below the fold on the last visible
 * line.
 */

/** The structural half of DOMRect this needs. A DOMRect is assignable to it. */
export interface AnchorRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export interface AnchorSize {
    width: number;
    height: number;
}

export interface AnchorViewport {
    width: number;
    height: number;
}

export type AnchorPlacement = 'above' | 'below';

export interface AnchorOptions {
    /** Supplied by tests. The only reason this function ever touches the DOM is its absence. */
    viewport?: AnchorViewport;
    /** Distance kept from every viewport edge. */
    margin?: number;
    /** Distance kept from the anchor itself. */
    gap?: number;
    /** Which side to try first. The other side is used when the first cannot hold the surface. */
    prefer?: AnchorPlacement;
    /** `center` puts the surface's midpoint over the anchor's, before clamping. */
    align?: 'start' | 'center';
}

export interface AnchorPosition {
    top: number;
    left: number;
    placement: AnchorPlacement;
}

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 6;

export function windowViewport(): AnchorViewport {
    return {width: window.innerWidth, height: window.innerHeight};
}

/**
 * Picks a side and clamps both axes.
 *
 * The returned `top`/`left` are viewport coordinates, ready for `position: fixed`. When the
 * surface is taller than either side can hold, the roomier side wins and the result is clamped
 * rather than left hanging off an edge, so the surface stays reachable even when it is cropped.
 */
export function anchorTo(anchor: AnchorRect, size: AnchorSize, options: AnchorOptions = {}): AnchorPosition {
    const viewport = options.viewport ?? windowViewport();
    const margin = options.margin ?? DEFAULT_MARGIN;
    const gap = options.gap ?? DEFAULT_GAP;
    const prefer = options.prefer ?? 'below';

    const roomBelow = viewport.height - anchor.bottom - gap - margin;
    const roomAbove = anchor.top - gap - margin;

    const first = prefer === 'below' ? roomBelow : roomAbove;
    const second = prefer === 'below' ? roomAbove : roomBelow;
    let placement: AnchorPlacement;
    if (size.height <= first) placement = prefer;
    else if (size.height <= second) placement = prefer === 'below' ? 'above' : 'below';
    else placement = roomBelow >= roomAbove ? 'below' : 'above';

    const rawTop = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - size.height;
    const rawLeft =
        options.align === 'center' ? (anchor.left + anchor.right) / 2 - size.width / 2 : anchor.left;

    return {
        top: clamp(rawTop, margin, viewport.height - size.height - margin),
        left: clamp(rawLeft, margin, viewport.width - size.width - margin),
        placement,
    };
}

/** A surface wider or taller than the viewport has an inverted range; the low edge wins there. */
function clamp(value: number, low: number, high: number): number {
    if (high < low) return low;
    return Math.max(low, Math.min(value, high));
}

export type WikiFloatingCloseReason = 'escape' | 'outside' | 'blur';

export interface WikiFloatingOptions {
    /** Called on open, on scroll and on resize. Re-measure and re-apply the position here. */
    reposition: () => void;
    close: (reason: WikiFloatingCloseReason) => void;
    /** True for a node inside the floating surface itself, whose pointerdown is not "outside". */
    contains?: (target: Node) => boolean;
    /** The editor surface. Losing focus out of it closes the floater. */
    blurTarget?: () => HTMLElement | null | undefined;
    /** Escape is handled by the editor's own keymap in some callers; false leaves it to them. */
    escape?: boolean;
}

/**
 * The listener half. Listeners exist only while open, so a shut menu costs nothing.
 *
 * `scroll` is captured because the article body scrolls, not the window, and a bubbling listener
 * on window never sees it.
 */
export class WikiFloatingController {
    private open = false;
    private readonly options: WikiFloatingOptions;

    private readonly onScroll = () => this.options.reposition();
    private readonly onResize = () => this.options.reposition();

    private readonly onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') this.options.close('escape');
    };

    private readonly onPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (target instanceof Node && this.options.contains?.(target)) return;
        this.options.close('outside');
    };

    private readonly onFocusOut = (event: FocusEvent) => {
        const next = event.relatedTarget;
        // Focus moving into the floater is not a blur out of the editor.
        if (next instanceof Node && this.options.contains?.(next)) return;
        this.options.close('blur');
    };

    constructor(options: WikiFloatingOptions) {
        this.options = options;
    }

    get isOpen(): boolean {
        return this.open;
    }

    attach(): void {
        if (this.open) return;
        this.open = true;
        window.addEventListener('scroll', this.onScroll, {capture: true, passive: true});
        window.addEventListener('resize', this.onResize, {passive: true});
        if (this.options.escape !== false) document.addEventListener('keydown', this.onKeyDown, true);
        document.addEventListener('pointerdown', this.onPointerDown, true);
        this.options.blurTarget?.()?.addEventListener('focusout', this.onFocusOut);
        this.options.reposition();
    }

    detach(): void {
        if (!this.open) return;
        this.open = false;
        window.removeEventListener('scroll', this.onScroll, true);
        window.removeEventListener('resize', this.onResize);
        document.removeEventListener('keydown', this.onKeyDown, true);
        document.removeEventListener('pointerdown', this.onPointerDown, true);
        this.options.blurTarget?.()?.removeEventListener('focusout', this.onFocusOut);
    }
}

/** Ties a controller's lifetime to the injecting component. Call from an injection context. */
export function injectWikiFloating(options: WikiFloatingOptions): WikiFloatingController {
    const controller = new WikiFloatingController(options);
    inject(DestroyRef).onDestroy(() => controller.detach());
    return controller;
}
