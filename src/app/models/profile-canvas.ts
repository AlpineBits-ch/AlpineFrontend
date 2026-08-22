import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';

export const CANVAS_COLUMNS = 4;
export const MAX_WIDGETS = 20;
export const MAX_CARD_WIDGETS = 2;
export const MAX_SPACERS = 20;
export const SPACER_TYPE = 'spacer';

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

export function isSpacer(widget: CanvasWidgetDto): boolean {
    return widget.type === SPACER_TYPE;
}

function fits(taken: Set<string>, x: number, y: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
            if (taken.has(`${x + dx},${y + dy}`)) return false;
        }
    }
    return true;
}

// Row scan bound for a widget height that isn't a real footprint. Not a footprint rule, just
// large enough that a stray NaN or Infinity can't hang or crash the packer.
const MAX_SPAN = 64;

/** A finite integer in [1, max]. widget.w and widget.h are typed number, so NaN and Infinity are legal inputs. */
function sanitiseDimension(value: number, max: number): number {
    const floored = Number.isFinite(value) ? Math.floor(value) : max;
    return Math.min(Math.max(floored, 1), max);
}

/**
 * Packs widgets into `columns`, first free cell wins. Array order out is reading order, which is
 * what lets the editor move an array element and leave x and y to be derived.
 */
export function reflow(widgets: CanvasWidgetDto[], columns: number): CanvasWidgetDto[] {
    const taken = new Set<string>();
    const placed: CanvasWidgetDto[] = [];

    for (const widget of [...widgets].sort(byReadingOrder)) {
        const w = sanitiseDimension(widget.w, columns);
        const h = sanitiseDimension(widget.h, MAX_SPAN);

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
        placed.push({...widget, x, y, w, h});
    }

    // Assigned (y, x) is a unique total order: two widgets never share a top-left cell. Sorting by
    // it is what keeps the array in reading order even when a later widget fills an earlier gap.
    return placed.sort(byReadingOrder);
}

/** The one gate every canvas passes through, on read and on write. */
export function normalise(canvas: ProfileCanvasDto, columns = CANVAS_COLUMNS): ProfileCanvasDto {
    let cardsLeft = MAX_CARD_WIDGETS;

    const clean = canvas.widgets.filter(
        widget => !!widget?.id && typeof widget.type === 'string' && widget.type.length > 0,
    );

    // Spacers are a four-column device: a stack of empty rows is dead scrolling on a phone.
    const capped =
        columns < CANVAS_COLUMNS
            ? clean.filter(widget => !isSpacer(widget)).slice(0, MAX_WIDGETS)
            : [
                  ...clean.filter(widget => !isSpacer(widget)).slice(0, MAX_WIDGETS),
                  ...clean.filter(isSpacer).slice(0, MAX_SPACERS),
              ];

    const widgets = capped.map(widget => {
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

function spacer(x: number, y: number, w: number): CanvasWidgetDto {
    return {
        id: `spacer-${crypto.randomUUID()}`,
        type: SPACER_TYPE,
        x,
        y,
        w,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
    };
}

/**
 * Lifts the dragged widget out, reflows the rest, then walks reading order toward `target`
 * counting unoccupied cells. Those cells become spacers, merged per row into the fewest legal
 * footprints, so the widget lands exactly on the dropped cell and the grid stays gapless.
 */
export function dropAt(
    widgets: CanvasWidgetDto[],
    id: string,
    target: {x: number; y: number},
    columns: number,
): CanvasWidgetDto[] {
    const dragged = widgets.find(widget => widget.id === id);
    if (!dragged) return widgets;

    const rest = reflow(
        widgets.filter(widget => widget.id !== id),
        columns,
    );

    const taken = new Set<string>();
    for (const widget of rest) {
        for (let dy = 0; dy < widget.h; dy++) {
            for (let dx = 0; dx < widget.w; dx++) taken.add(`${widget.x + dx},${widget.y + dy}`);
        }
    }

    const targetX = Math.min(Math.max(Math.floor(target.x), 0), columns - 1);
    const targetY = Math.max(Math.floor(target.y), 0);

    const spacers: CanvasWidgetDto[] = [];
    let landX = targetX;
    let landY = targetY;

    rows: for (let y = 0; y <= targetY; y++) {
        let x = 0;
        while (x < columns) {
            if (y === targetY && x === targetX) break rows;

            if (taken.has(`${x},${y}`)) {
                x++;
                continue;
            }

            let runEnd = x;
            while (
                runEnd < columns &&
                !taken.has(`${runEnd},${y}`) &&
                !(y === targetY && runEnd === targetX)
            ) {
                runEnd++;
            }

            let rx = x;
            while (rx < runEnd) {
                const width = runEnd - rx >= 4 ? 4 : runEnd - rx >= 2 ? 2 : 1;
                spacers.push(spacer(rx, y, width));
                rx += width;

                if (spacers.length >= MAX_SPACERS) {
                    landX = rx < columns ? rx : 0;
                    landY = rx < columns ? y : y + 1;
                    break rows;
                }
            }

            x = runEnd;
        }
    }

    const placed: CanvasWidgetDto = {...dragged, x: landX, y: landY};
    return reflow([...rest, ...spacers, placed], columns);
}

/** Trailing spacers are invisible whitespace, but a trailing one is how you keep dragging downward. */
export function trimTrailingSpacers(widgets: CanvasWidgetDto[]): CanvasWidgetDto[] {
    let lastReal = -1;
    for (let i = widgets.length - 1; i >= 0; i--) {
        if (!isSpacer(widgets[i])) {
            lastReal = i;
            break;
        }
    }
    return widgets.slice(0, lastReal + 1);
}

/** A config that fails its widget's guard renders as an empty cell, never as a thrown error. */
export function parseConfig<T>(config: unknown, guard: (value: unknown) => value is T): T | null {
    return guard(config) ? config : null;
}
