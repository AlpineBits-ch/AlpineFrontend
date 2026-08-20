import {ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input} from '@angular/core';
import {WikiDto} from '../../../../../dtos/response/wiki.dto';
import {boundsOf, buildGraphFrom, graphLinksOf, nodeColor, nodeRadius, PageLink, settle} from './wiki-graph';
import {WikiGraphSourceService} from './wiki-graph-source.service';

/** Enough to read as a constellation, few enough to settle in well under a frame. */
const PREVIEW_NODES = 44;
const PREVIEW_STEPS = 260;

/**
 * The still frame of the graph that sits on the home page. Static SVG, not a second live canvas.
 * Links come from the graph endpoint, which costs one small request and no page bodies; a wiki
 * whose server has no such endpoint gets the tree alone, drawn dashed, which is what it is.
 */
@Component({
    selector: 'app-wiki-graph-preview',
    template: `
        @if (view(); as v) {
            <svg
                [attr.viewBox]="v.viewBox"
                aria-hidden="true"
                class="h-full w-full"
                preserveAspectRatio="xMidYMid slice"
            >
                @for (edge of v.hierarchyEdges; track $index) {
                    <line
                        [attr.x1]="edge.x1"
                        [attr.x2]="edge.x2"
                        [attr.y1]="edge.y1"
                        [attr.y2]="edge.y2"
                        class="text-white/15"
                        stroke="currentColor"
                        stroke-dasharray="4 4"
                        stroke-width="0.8"
                    />
                }
                @for (edge of v.linkEdges; track $index) {
                    <line
                        [attr.stroke]="v.accent"
                        [attr.x1]="edge.x1"
                        [attr.x2]="edge.x2"
                        [attr.y1]="edge.y1"
                        [attr.y2]="edge.y2"
                        opacity="0.5"
                        stroke-width="1.7"
                    />
                }
                @for (node of v.nodes; track node.id) {
                    <circle
                        [attr.cx]="node.x"
                        [attr.cy]="node.y"
                        [attr.fill]="node.color"
                        [attr.r]="node.r"
                        opacity="0.9"
                    />
                }
            </svg>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'block'},
})
export class WikiGraphPreviewComponent {
    readonly wiki = input<WikiDto | null>(null);

    private readonly source = inject(WikiGraphSourceService);
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    protected readonly view = computed(() => {
        const wiki = this.wiki();
        const pages = wiki?.pages ?? [];
        if (!pages.length) return null;

        // Newest first, so the preview shows the part of the wiki that is actually in use.
        const subset = [...pages]
            .sort((a, b) => epoch(b.updatedAt) - epoch(a.updatedAt))
            .slice(0, PREVIEW_NODES);

        const accent =
            getComputedStyle(this.host.nativeElement).getPropertyValue('--color-brand-dim').trim() ||
            'rgb(154,132,255)';

        const graph = wiki ? this.source.graphs().get(wiki.guildId) : null;
        // The subset already carries the tree; only the links have to be looked up, and an end
        // outside the subset is dropped by the builder.
        const links: PageLink[] = graph ? graphLinksOf(graph) : [];
        const model = settle(buildGraphFrom(subset, links, wiki?.categories ?? []), PREVIEW_STEPS);
        const bounds = boundsOf(model, 10);

        return {
            accent,
            viewBox: [
                bounds.minX,
                bounds.minY,
                Math.max(1, bounds.maxX - bounds.minX),
                Math.max(1, bounds.maxY - bounds.minY),
            ].join(' '),
            hierarchyEdges: model.edges.filter(e => e.kind === 'hierarchy').map(e => segment(model, e)),
            linkEdges: model.edges.filter(e => e.kind === 'link').map(e => segment(model, e)),
            nodes: model.nodes.map(node => ({
                id: node.id,
                x: node.x,
                y: node.y,
                r: nodeRadius(node),
                color: nodeColor(node.colorIndex, accent),
            })),
        };
    });

    constructor() {
        effect(() => {
            const guildId = this.wiki()?.guildId;
            // Never a warm: pulling every page body onto the home page for a thumbnail is what this
            // endpoint exists to stop.
            if (guildId) this.source.load(guildId);
        });
    }
}

function segment(model: {nodes: {x: number; y: number}[]}, edge: {a: number; b: number}) {
    return {
        x1: model.nodes[edge.a].x,
        y1: model.nodes[edge.a].y,
        x2: model.nodes[edge.b].x,
        y2: model.nodes[edge.b].y,
    };
}

function epoch(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? 0 : ms;
}
