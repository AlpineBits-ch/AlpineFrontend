import {WikiCategoryDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {extractLinkedPageIds} from '../wiki-links';

/**
 * The wiki as a map: pages are nodes, `wiki:` links are edges, categories are colour.
 * Layout is deterministic: initial positions come from a hash of the page id, never `Math.random()`, so the static preview and the full view always agree.
 */

/** Above this the O(n²) pass stops being free and the picture stops being readable anyway. */
export const GRAPH_NODE_LIMIT = 400;

const LINK_DISTANCE = 64;
const SPRING = 0.03;
const REPULSION = 3_000;
/** Beyond this, repulsion is left to centre gravity: it is what stops far clusters exploding. */
const REPULSION_CUTOFF = 420;
const CENTER_PULL = 0.006;
const DAMPING = 0.82;
/** A node crossing half the canvas in one frame reads as a glitch, not as physics. */
const MAX_SPEED = 12;

export const ALPHA_START = 1;
/** Below this the picture stops visibly moving, so the loop stops with it. */
export const ALPHA_MIN = 0.01;
/** What an interaction (drag, resize, new data) reheats to: warm enough to relax, not to fling. */
export const ALPHA_REHEAT = 0.4;
const ALPHA_DECAY = 0.022;

export interface GraphNode {
    id: string;
    title: string;
    categoryId?: string;
    /** Index into the colour ramp, `-1` for a page in no category. */
    colorIndex: number;
    degree: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Held in place by a drag; forces still apply to its neighbours, not to it. */
    pinned: boolean;
}

export interface GraphEdge {
    a: number;
    b: number;
}

export interface GraphModel {
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** Neighbour indices per node, so the hover highlight is a lookup and not a scan of edges. */
    neighbours: readonly (readonly number[])[];
    /** Pages left out by {@link GRAPH_NODE_LIMIT}, so the view can say so instead of lying. */
    omitted: number;
}

export interface Point {
    x: number;
    y: number;
}

export function buildGraph(
    pages: readonly WikiPageSummaryDto[],
    contentByPageId: ReadonlyMap<string, string>,
    categories: readonly WikiCategoryDto[] = [],
    previous?: ReadonlyMap<string, Point>,
): GraphModel {
    const known = new Set(pages.map(p => p.id));

    // Links first: the node cap wants to keep the most connected pages, which cannot be known before the links are read.
    const linksBySource = new Map<string, string[]>();
    const degree = new Map<string, number>();
    for (const page of pages) {
        const body = contentByPageId.get(page.id);
        // A link to a page that no longer exists is not an edge: it has no other end.
        const written = body
            ? extractLinkedPageIds(body).filter(id => id !== page.id && known.has(id))
            : [];

        // A page's parent counts as an edge too, not just its written `wiki:` links, so a filed-under page with no body links still shows as connected.
        const parent = page.parentPageId;
        // Deduped: a page filed under another and also linking to it in its body counts once, since `degree` sizes the node and decides what survives the node cap.
        const targets = [...new Set(
            parent && parent !== page.id && known.has(parent) ? [...written, parent] : written,
        )];
        if (!targets.length) continue;

        linksBySource.set(page.id, targets);
        degree.set(page.id, (degree.get(page.id) ?? 0) + targets.length);
        for (const target of targets) degree.set(target, (degree.get(target) ?? 0) + 1);
    }

    const ranked = [...pages].sort((a, b) =>
        (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
        || epoch(b.updatedAt) - epoch(a.updatedAt)
        || a.id.localeCompare(b.id));
    const kept = ranked.slice(0, GRAPH_NODE_LIMIT);
    const omitted = pages.length - kept.length;

    // Colour follows the category order the nav shows, so the graph and the tree agree.
    const colorIndexByCategory = new Map(
        [...categories]
            .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
            .map((category, index) => [category.id, index] as const),
    );

    const nodes: GraphNode[] = kept.map(page => {
        const seed = previous?.get(page.id) ?? seedPosition(page.id);
        return {
            id: page.id,
            title: page.title,
            categoryId: page.categoryId,
            colorIndex: page.categoryId ? colorIndexByCategory.get(page.categoryId) ?? -1 : -1,
            degree: degree.get(page.id) ?? 0,
            x: seed.x,
            y: seed.y,
            vx: 0,
            vy: 0,
            pinned: false,
        };
    });

    const indexById = new Map(nodes.map((node, index) => [node.id, index] as const));
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const neighbours: number[][] = nodes.map(() => []);
    for (const [sourceId, targets] of linksBySource) {
        const a = indexById.get(sourceId);
        if (a === undefined) continue;
        for (const targetId of targets) {
            const b = indexById.get(targetId);
            if (b === undefined) continue;
            // Undirected: A links to B and B links back is one line, not two drawn on top of each other at double opacity.
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({a, b});
            neighbours[a].push(b);
            neighbours[b].push(a);
        }
    }

    return {nodes, edges, neighbours, omitted};
}

/** One integration step. Mutates in place: this runs every frame and must not allocate. */
export function stepSimulation(model: GraphModel, alpha: number): void {
    const {nodes, edges} = model;
    const count = nodes.length;
    const cutoff = REPULSION_CUTOFF * REPULSION_CUTOFF;

    for (let i = 0; i < count; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < count; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > cutoff) continue;
            if (d2 < 0.01) {
                // Two nodes at the identical seed would divide by zero and stay stuck together forever; nudge them apart along a fixed axis so the result stays deterministic.
                dx = 0.1;
                dy = 0;
                d2 = 0.01;
            }
            const distance = Math.sqrt(d2);
            const force = REPULSION / d2;
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
        }
    }

    for (const edge of edges) {
        const a = nodes[edge.a];
        const b = nodes[edge.b];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (distance - LINK_DISTANCE) * SPRING;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
    }

    for (const node of nodes) {
        node.vx -= node.x * CENTER_PULL;
        node.vy -= node.y * CENTER_PULL;

        const speed = Math.hypot(node.vx, node.vy);
        if (speed > MAX_SPEED) {
            node.vx = (node.vx / speed) * MAX_SPEED;
            node.vy = (node.vy / speed) * MAX_SPEED;
        }

        if (node.pinned) {
            node.vx = 0;
            node.vy = 0;
            continue;
        }

        node.x += node.vx * alpha;
        node.y += node.vy * alpha;
        node.vx *= DAMPING;
        node.vy *= DAMPING;
    }
}

export function coolAlpha(alpha: number): number {
    return alpha - alpha * ALPHA_DECAY;
}

/**
 * Runs the simulation to rest without a frame loop, for the static preview on the home page.
 * A few hundred steps over forty nodes is under a millisecond and happens once.
 */
export function settle(model: GraphModel, steps = 300): GraphModel {
    let alpha = ALPHA_START;
    for (let i = 0; i < steps && alpha > ALPHA_MIN; i++) {
        stepSimulation(model, alpha);
        alpha = coolAlpha(alpha);
    }
    return model;
}

export function nodeRadius(node: GraphNode): number {
    return 4 + Math.min(8, Math.sqrt(node.degree) * 2.6);
}

/**
 * Category colour, generated on a golden-angle hue rotation so any number of categories gets
 * legible, distinct hues. Uncategorised pages fall back to the theme's own accent, read from the
 * live custom property so runtime theming applies.
 */
export function nodeColor(colorIndex: number, fallback: string): string {
    if (colorIndex < 0) return fallback;
    return `hsl(${(colorIndex * 137.508) % 360} 68% 63%)`;
}

export function positionsOf(model: GraphModel): Map<string, Point> {
    return new Map(model.nodes.map(node => [node.id, {x: node.x, y: node.y}] as const));
}

/** Nearest node under a graph-space point, or `null`. `slack` widens the target for a cursor. */
export function hitTest(model: GraphModel, x: number, y: number, slack = 6): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < model.nodes.length; i++) {
        const node = model.nodes[i];
        const distance = Math.hypot(node.x - x, node.y - y);
        const reach = nodeRadius(node) + slack;
        if (distance <= reach && distance < bestDistance) {
            best = i;
            bestDistance = distance;
        }
    }
    return best;
}

export interface GraphBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export function boundsOf(model: GraphModel, padding = 24): GraphBounds {
    if (!model.nodes.length) return {minX: -1, minY: -1, maxX: 1, maxY: 1};
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of model.nodes) {
        const r = nodeRadius(node);
        minX = Math.min(minX, node.x - r);
        minY = Math.min(minY, node.y - r);
        maxX = Math.max(maxX, node.x + r);
        maxY = Math.max(maxY, node.y + r);
    }
    return {
        minX: minX - padding,
        minY: minY - padding,
        maxX: maxX + padding,
        maxY: maxY + padding,
    };
}

/** A stable starting point per page id; placed on a ring, not a filled disc, since starting every node near the centre makes the first dozen frames an explosion. */
function seedPosition(id: string): Point {
    const h = hash(id);
    const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
    const radius = 90 + ((h >>> 16) & 0xff);
    return {x: Math.cos(angle) * radius, y: Math.sin(angle) * radius};
}

/** FNV-1a. Not cryptographic: it only has to be stable and well spread. */
function hash(value: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function epoch(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? 0 : ms;
}
