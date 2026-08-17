import {
    ALPHA_START,
    boundsOf,
    buildGraph,
    coolAlpha,
    GRAPH_NODE_LIMIT,
    hitTest,
    nodeColor,
    positionsOf,
    settle,
} from './wiki-graph';
import {WikiCategoryDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';

function page(id: string, over: Partial<WikiPageSummaryDto> = {}): WikiPageSummaryDto {
    return {
        id,
        guildId: 'g',
        title: id.toUpperCase(),
        slug: id,
        authorId: 'author',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        visibility: 'public',
        tags: [],
        isPinned: false,
        revisionCount: 0,
        ...over,
    };
}

function category(id: string, position: number): WikiCategoryDto {
    return {id, guildId: 'g', name: id, position};
}

describe('buildGraph', () => {
    it('turns a wiki link into an edge between the two pages', () => {
        const model = buildGraph(
            [page('a'), page('b')],
            new Map([['a', 'see [B](wiki:b)']]),
        );
        expect(model.edges.length).toBe(1);
        expect(model.nodes[model.edges[0].a].id).toBe('a');
        expect(model.nodes[model.edges[0].b].id).toBe('b');
    });

    // Two lines drawn on top of each other read as one link at double opacity, which is a lie
    // about how strongly the two pages are connected.
    it('collapses a reciprocal pair of links into one edge', () => {
        const model = buildGraph(
            [page('a'), page('b')],
            new Map([['a', '[B](wiki:b)'], ['b', '[A](wiki:a)']]),
        );
        expect(model.edges.length).toBe(1);
    });

    it('ignores a self-link', () => {
        const model = buildGraph([page('a')], new Map([['a', '[me](wiki:a)']]));
        expect(model.edges).toEqual([]);
    });

    it('ignores a link to a page that no longer exists', () => {
        const model = buildGraph([page('a')], new Map([['a', '[gone](wiki:ghost)']]));
        expect(model.edges).toEqual([]);
    });

    it('records neighbours in both directions', () => {
        const model = buildGraph(
            [page('a'), page('b')],
            new Map([['a', '[B](wiki:b)']]),
        );
        expect(model.neighbours[0]).toEqual([1]);
        expect(model.neighbours[1]).toEqual([0]);
    });

    it('has no edges at all before the content cache is warm', () => {
        const model = buildGraph([page('a'), page('b')], new Map());
        expect(model.nodes.length).toBe(2);
        expect(model.edges).toEqual([]);
    });

    it('draws a line for a page filed under another, with nothing written between them', () => {
        const model = buildGraph([page('a'), page('b', {parentPageId: 'a'})], new Map());
        expect(model.edges.length).toBe(1);
        expect(model.neighbours[0]).toEqual([1]);
        expect(model.neighbours[1]).toEqual([0]);
    });

    it('counts a parent that is also linked in the body once', () => {
        const model = buildGraph(
            [page('a'), page('b', {parentPageId: 'a'})],
            new Map([['b', 'see [a](wiki:a)']]),
        );
        expect(model.edges.length).toBe(1);
        // Degree sizes the node and decides what survives the cap, so a double count shows.
        expect(model.nodes.map(n => n.degree)).toEqual([1, 1]);
    });

    it('ignores a parent that is not a page in this wiki', () => {
        const model = buildGraph([page('b', {parentPageId: 'gone'})], new Map());
        expect(model.edges).toEqual([]);
    });

    it('colours by the category order the nav shows, and leaves uncategorised pages at -1', () => {
        const model = buildGraph(
            [page('a', {categoryId: 'second'}), page('b', {categoryId: 'first'}), page('c')],
            new Map(),
            [category('second', 2), category('first', 1)],
        );
        const byId = new Map(model.nodes.map(n => [n.id, n.colorIndex]));
        expect(byId.get('b')).toBe(0);
        expect(byId.get('a')).toBe(1);
        expect(byId.get('c')).toBe(-1);
    });

    it('caps the node count and reports what it left out', () => {
        const pages = Array.from({length: GRAPH_NODE_LIMIT + 5}, (_, i) => page(`p${i}`));
        const model = buildGraph(pages, new Map());
        expect(model.nodes.length).toBe(GRAPH_NODE_LIMIT);
        expect(model.omitted).toBe(5);
    });

    // A remount that reshuffled the layout would make the map unrecognisable between visits.
    it('places nodes deterministically', () => {
        const first = buildGraph([page('a'), page('b')], new Map());
        const second = buildGraph([page('a'), page('b')], new Map());
        expect(positionsOf(first)).toEqual(positionsOf(second));
    });

    it('reuses the previous positions so a data refresh does not restart the layout', () => {
        const model = buildGraph([page('a')], new Map(), [], new Map([['a', {x: 12, y: -34}]]));
        expect({x: model.nodes[0].x, y: model.nodes[0].y}).toEqual({x: 12, y: -34});
    });
});

describe('simulation', () => {
    it('cools towards rest', () => {
        let alpha = ALPHA_START;
        for (let i = 0; i < 500; i++) alpha = coolAlpha(alpha);
        expect(alpha).toBeLessThan(0.01);
    });

    it('pushes two unlinked pages apart', () => {
        const model = buildGraph([page('a'), page('b')], new Map());
        model.nodes[0].x = 0;
        model.nodes[0].y = 0;
        model.nodes[1].x = 5;
        model.nodes[1].y = 0;
        settle(model);
        expect(Math.abs(model.nodes[1].x - model.nodes[0].x)).toBeGreaterThan(5);
    });

    it('leaves every coordinate finite', () => {
        const pages = Array.from({length: 40}, (_, i) => page(`p${i}`));
        const content = new Map(pages.map((p, i) => [p.id, `[x](wiki:p${(i + 1) % 40})`]));
        const model = settle(buildGraph(pages, content));
        expect(model.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    });

    it('holds a pinned node exactly where the drag put it', () => {
        const model = buildGraph([page('a'), page('b')], new Map());
        model.nodes[0].pinned = true;
        const before = {x: model.nodes[0].x, y: model.nodes[0].y};
        settle(model);
        expect({x: model.nodes[0].x, y: model.nodes[0].y}).toEqual(before);
    });
});

describe('hitTest', () => {
    it('finds the node under the point and nothing when there is none', () => {
        const model = buildGraph([page('a')], new Map());
        const node = model.nodes[0];
        expect(hitTest(model, node.x, node.y)).toBe(0);
        expect(hitTest(model, node.x + 500, node.y)).toBeNull();
    });
});

describe('nodeColor', () => {
    it('falls back to the supplied accent for an uncategorised page', () => {
        expect(nodeColor(-1, '#fallback')).toBe('#fallback');
    });

    it('gives neighbouring categories distinct hues', () => {
        expect(nodeColor(0, '#x')).not.toBe(nodeColor(1, '#x'));
    });
});

describe('boundsOf', () => {
    it('returns a usable box for an empty graph rather than an infinite one', () => {
        const bounds = boundsOf(buildGraph([], new Map()));
        expect(Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxY)).toBe(true);
    });
});
