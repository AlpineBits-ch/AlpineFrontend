import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';

export const CANVAS_COLUMNS = 4;
export const MAX_WIDGETS = 20;
export const MAX_CARD_WIDGETS = 2;

export interface Footprint {
    w: number;
    h: number;
}

/** The only shapes that validate. Ordered small to large; snapFootprint relies on that. */
export const FOOTPRINTS: readonly Footprint[] = [
    {w: 1, h: 1},
    {w: 2, h: 1},
    {w: 2, h: 2},
    {w: 4, h: 1},
    {w: 4, h: 2},
];

export function emptyCanvas(profileId: string): ProfileCanvasDto {
    return {
        profileId,
        updatedAt: '',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets: [],
    };
}

/** The largest legal footprint that fits inside the requested one, or the smallest if none does. */
export function snapFootprint(w: number, h: number): Footprint {
    const width = Math.floor(w);
    const height = Math.floor(h);
    let best: Footprint = FOOTPRINTS[0];
    for (const candidate of FOOTPRINTS) {
        if (candidate.w <= width && candidate.h <= height) best = candidate;
    }
    return {...best};
}

function byReadingOrder(a: CanvasWidgetDto, b: CanvasWidgetDto): number {
    return a.y - b.y || a.x - b.x;
}

function fits(taken: Set<string>, x: number, y: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            if (taken.has(`${x + dx},${y + dy}`)) return false;
        }
    }
    return true;
}

/**
 * Packs widgets into `columns`, first free cell wins. Array order out is reading order, which is
 * what lets the editor move an array element and leave x and y to be derived.
 */
export function reflow(widgets: CanvasWidgetDto[], columns: number): CanvasWidgetDto[] {
    const taken = new Set<string>();
    const placed: CanvasWidgetDto[] = [];

    for (const widget of [...widgets].sort(byReadingOrder)) {
        const w = Math.min(widget.w, columns);
        const h = widget.h;

        let x = 0;
        let y = 0;
        // Bounded: every row past the widget count is empty, so this always terminates.
        for (y = 0; ; y++) {
            const free = [...Array(columns - w + 1).keys()].find(candidate =>
                fits(taken, candidate, y, w, h),
            );
            if (free !== undefined) {
                x = free;
                break;
            }
        }

        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) taken.add(`${x + dx},${y + dy}`);
        }
        placed.push({...widget, x, y, w});
    }

    return placed;
}

/** The one gate every canvas passes through, on read and on write. */
export function normalise(canvas: ProfileCanvasDto, columns = CANVAS_COLUMNS): ProfileCanvasDto {
    let cardsLeft = MAX_CARD_WIDGETS;

    const widgets = canvas.widgets
        .filter(widget => !!widget?.id && typeof widget.type === 'string' && widget.type.length > 0)
        .slice(0, MAX_WIDGETS)
        .map(widget => {
            const footprint = snapFootprint(widget.w, widget.h);
            const card = widget.card && cardsLeft > 0;
            if (card) cardsLeft--;
            return {
                ...widget,
                ...footprint,
                card,
                config: widget.config && typeof widget.config === 'object' ? widget.config : {},
            };
        });

    return {...canvas, widgets: reflow(widgets, columns)};
}

/** A config that fails its widget's guard renders as an empty cell, never as a thrown error. */
export function parseConfig<T>(config: unknown, guard: (value: unknown) => value is T): T | null {
    return guard(config) ? config : null;
}
