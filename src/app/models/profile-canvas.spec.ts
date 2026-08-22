import {describe, expect, it} from 'vitest';
import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {
    CANVAS_COLUMNS,
    MAX_WIDGETS,
    emptyCanvas,
    normalise,
    parseConfig,
    reflow,
    snapFootprint,
} from './profile-canvas';

function widget(id: string, over: Partial<CanvasWidgetDto> = {}): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
        ...over,
    };
}

function canvas(widgets: CanvasWidgetDto[]): ProfileCanvasDto {
    return {
        profileId: 'p1',
        updatedAt: '2026-08-22T00:00:00Z',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets,
    };
}

describe('snapFootprint', () => {
    it('keeps a legal footprint', () => {
        expect(snapFootprint(2, 2)).toEqual({w: 2, h: 2});
    });

    it('snaps an unknown footprint down to the largest that fits inside it', () => {
        expect(snapFootprint(3, 2)).toEqual({w: 2, h: 2});
    });

    it('falls back to the smallest footprint when nothing fits', () => {
        expect(snapFootprint(0, 0)).toEqual({w: 1, h: 1});
    });

    it('rejects a non-integer size', () => {
        // 3.9 floors to 3, which still snaps to {2, 1}; ceil would round it up to the {4, 1}
        // footprint instead, so this distinguishes truncation direction where 2.5 could not.
        expect(snapFootprint(3.9, 1)).toEqual({w: 2, h: 1});
    });
});

describe('reflow', () => {
    it('packs two 2x1 widgets into one row of four columns', () => {
        const out = reflow([widget('a'), widget('b')], 4);
        expect(out.map(v => [v.x, v.y])).toEqual([
            [0, 0],
            [2, 0],
        ]);
    });

    it('wraps to the next row when the current one is full', () => {
        const out = reflow([widget('a'), widget('b'), widget('c')], 4);
        expect(out[2].x).toBe(0);
        expect(out[2].y).toBe(1);
    });

    it('clamps a widget wider than the grid', () => {
        const out = reflow([widget('a', {w: 4})], 2);
        expect(out[0].w).toBe(2);
    });

    it('preserves reading order when it repacks', () => {
        const input = [widget('b', {y: 1}), widget('a', {y: 0})];
        expect(reflow(input, 4).map(v => v.id)).toEqual(['a', 'b']);
    });

    it('fills a gap beside a tall widget rather than leaving a hole', () => {
        const out = reflow([widget('tall', {w: 2, h: 2}), widget('short', {w: 2, h: 1})], 4);
        expect(out[1]).toMatchObject({x: 2, y: 0});
    });

    it('is stable: reflowing its own output changes nothing', () => {
        // A later widget ('f') fills the gap left at (2, 0) beside the two full-row widgets
        // above it. That gap-fill is what a naive push-in-processing-order return misses: the
        // array below regresses to processing order, not the reading order the widget landed in.
        const input = [
            widget('a', {w: 2, h: 1}),
            widget('b', {w: 4, h: 1}),
            widget('c', {w: 4, h: 1}),
            widget('d', {w: 2, h: 2}),
            widget('e', {w: 2, h: 2}),
            widget('f', {w: 2, h: 1}),
        ];
        const once = reflow(input, 4);
        const readingOrder = [...once].sort((a, b) => a.y - b.y || a.x - b.x);
        expect(once).toEqual(readingOrder);
        expect(reflow(once, 4)).toEqual(once);
    });

    it('returns instead of hanging on an infinite height', () => {
        const out = reflow([widget('a', {w: 2, h: Infinity})], 4);
        expect(out).toHaveLength(1);
        expect(Number.isFinite(out[0].h)).toBe(true);
        expect(out[0].h).toBeGreaterThan(0);
        expect(out[0].x).toBe(0);
        expect(out[0].y).toBe(0);
    });

    it('returns instead of throwing on a NaN width', () => {
        const out = reflow([widget('a', {w: NaN, h: 1})], 4);
        expect(out).toHaveLength(1);
        expect(Number.isFinite(out[0].w)).toBe(true);
        expect(out[0].w).toBeGreaterThan(0);
        expect(out[0].w).toBeLessThanOrEqual(4);
        expect(out[0].x).toBe(0);
        expect(out[0].y).toBe(0);
    });
});

describe('normalise', () => {
    it('drops widgets past the cap', () => {
        const many = Array.from({length: MAX_WIDGETS + 5}, (_, i) => widget(`w${i}`, {w: 1}));
        expect(normalise(canvas(many)).widgets).toHaveLength(MAX_WIDGETS);
    });

    it('coerces a non-object config to an empty object', () => {
        expect(normalise(canvas([widget('a', {config: 'nonsense'})])).widgets[0].config).toEqual({});
    });

    it('snaps an illegal footprint instead of dropping the widget', () => {
        const out = normalise(canvas([widget('a', {w: 3, h: 2})]));
        expect(out.widgets).toHaveLength(1);
        expect(out.widgets[0]).toMatchObject({w: 2, h: 2});
    });

    it('keeps a widget whose type it does not know', () => {
        expect(normalise(canvas([widget('a', {type: 'from-the-future'})])).widgets).toHaveLength(1);
    });

    it('drops a widget with no id', () => {
        expect(normalise(canvas([widget('')])).widgets).toHaveLength(0);
    });

    it('leaves at most two card widgets', () => {
        const cards = [widget('a', {card: true}), widget('b', {card: true}), widget('c', {card: true})];
        expect(normalise(canvas(cards)).widgets.filter(v => v.card)).toHaveLength(2);
    });

    it('defaults to four columns', () => {
        expect(normalise(canvas([widget('a', {w: 4})])).widgets[0].w).toBe(CANVAS_COLUMNS);
    });
});

describe('parseConfig', () => {
    const isQuote = (v: unknown): v is {text: string} =>
        !!v && typeof v === 'object' && typeof (v as {text?: unknown}).text === 'string';

    it('returns the config when the guard passes', () => {
        expect(parseConfig({text: 'hi'}, isQuote)).toEqual({text: 'hi'});
    });

    it('returns null when the guard fails', () => {
        expect(parseConfig({text: 42}, isQuote)).toBeNull();
    });

    it('returns null for a nullish config', () => {
        expect(parseConfig(undefined, isQuote)).toBeNull();
    });
});

describe('emptyCanvas', () => {
    it('is a valid canvas with no widgets', () => {
        const out = emptyCanvas('p9');
        expect(out.profileId).toBe('p9');
        expect(out.widgets).toEqual([]);
        expect(normalise(out)).toEqual(out);
    });
});
