import {Component, computed, ElementRef, inject, input} from '@angular/core';
import {WikiDto} from '../../../../../dtos/response/wiki.dto';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {boundsOf, buildGraph, nodeColor, nodeRadius, settle} from './wiki-graph';

/** Enough to read as a constellation, few enough to settle in well under a frame. */
const PREVIEW_NODES = 44;
const PREVIEW_STEPS = 260;

/**
 * The still frame of the graph that sits on the home page. Static SVG, not a second live canvas.
 * Deliberately does not warm the content cache (see {@link WikiContentCacheService}); it draws
 * whatever links are already cached, a bare constellation on a cold start.
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
                @for (edge of v.edges; track $index) {
                    <line
                        [attr.x1]="edge.x1"
                        [attr.x2]="edge.x2"
                        [attr.y1]="edge.y1"
                        [attr.y2]="edge.y2"
                        stroke="currentColor"
                        stroke-width="1"
                        class="text-white/15"
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
    host: {class: 'block'},
})
export class WikiGraphPreviewComponent {
    readonly wiki = input<WikiDto | null>(null);

    private readonly cache = inject(WikiContentCacheService);
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
        const model = settle(buildGraph(subset, this.cache.content(), wiki?.categories ?? []), PREVIEW_STEPS);
        const bounds = boundsOf(model, 10);

        return {
            viewBox: [
                bounds.minX,
                bounds.minY,
                Math.max(1, bounds.maxX - bounds.minX),
                Math.max(1, bounds.maxY - bounds.minY),
            ].join(' '),
            edges: model.edges.map(edge => ({
                x1: model.nodes[edge.a].x,
                y1: model.nodes[edge.a].y,
                x2: model.nodes[edge.b].x,
                y2: model.nodes[edge.b].y,
            })),
            nodes: model.nodes.map(node => ({
                id: node.id,
                x: node.x,
                y: node.y,
                r: nodeRadius(node),
                color: nodeColor(node.colorIndex, accent),
            })),
        };
    });
}

function epoch(value: Date | string | null | undefined): number {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? 0 : ms;
}
