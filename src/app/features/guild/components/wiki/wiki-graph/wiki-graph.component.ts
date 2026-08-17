import {
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {
    ALPHA_MIN,
    ALPHA_REHEAT,
    ALPHA_START,
    boundsOf,
    buildGraph,
    coolAlpha,
    GraphModel,
    GraphNode,
    hitTest,
    nodeColor,
    nodeRadius,
    positionsOf,
    stepSimulation,
} from './wiki-graph';

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;
/** Past this a pointer gesture is a drag, not a click that happened to wobble. */
const CLICK_SLOP = 4;
/** Below this zoom every label overlaps every other one, so only the hub pages keep theirs. */
const LABEL_SCALE = 0.75;
const LABEL_ALL_SCALE = 1.3;
const LABEL_MIN_DEGREE = 2;

@Component({
    selector: 'app-wiki-graph',
    imports: [Button, Tooltip, TranslateModule],
    templateUrl: './wiki-graph.component.html',
    styleUrl: './wiki-graph.component.css',
    host: {class: 'flex flex-col h-full min-h-0'},
})
export class WikiGraphComponent {
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();

    readonly openPage = output<WikiPageSummaryDto>();
    readonly back = output<void>();

    protected readonly cache = inject(WikiContentCacheService);

    protected readonly model = signal<GraphModel | null>(null);
    protected readonly hovered = signal<GraphNode | null>(null);
    protected readonly scale = signal(1);
    protected readonly dragging = signal(false);
    /** Set when the canvas cannot be used at all; the list below is the same information without the physics, not a lesser fallback. */
    protected readonly unavailable = signal(false);
    /** User-chosen list mode. Also the keyboard-accessible route to every page in the graph. */
    protected readonly listMode = signal(false);

    protected readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

    /** How much of the wiki the graph can actually see. Edges need bodies; bodies need the warm. */
    protected readonly coverage = computed(() => {
        const pages = this.wiki()?.pages ?? [];
        const content = this.cache.content();
        return {
            total: pages.length,
            loaded: pages.reduce((n, page) => n + (content.has(page.id) ? 1 : 0), 0),
        };
    });

    protected readonly edgeCount = computed(() => this.model()?.edges.length ?? 0);
    protected readonly nodeCount = computed(() => this.model()?.nodes.length ?? 0);
    protected readonly omitted = computed(() => this.model()?.omitted ?? 0);

    /** Colour key, in the same order the graph assigns hues. */
    protected readonly legend = computed(() => {
        const categories = [...(this.wiki()?.categories ?? [])].sort(
            (a, b) => a.position - b.position || a.id.localeCompare(b.id),
        );
        return categories.map((category, index) => ({
            id: category.id,
            name: category.name,
            color: nodeColor(index, this.accent),
        }));
    });

    /** Every page, for the list fallback, most-linked first so the shape still comes through. */
    protected readonly listPages = computed(() => {
        const byId = new Map((this.wiki()?.pages ?? []).map(p => [p.id, p]));
        return (this.model()?.nodes ?? [])
            .map(node => ({node, page: byId.get(node.id), color: nodeColor(node.colorIndex, this.accent)}))
            .filter((row): row is {node: GraphNode; page: WikiPageSummaryDto; color: string} => !!row.page)
            .sort((a, b) => b.node.degree - a.node.degree || a.page.title.localeCompare(b.page.title));
    });

    private ctx: CanvasRenderingContext2D | null = null;
    private frame: number | undefined;
    private onScreen = true;
    private alpha = ALPHA_START;
    private needsFit = true;
    private viewWidth = 0;
    private viewHeight = 0;
    /** Graph-space point sitting at the centre of the canvas. */
    private camX = 0;
    private camY = 0;
    private pointerId: number | null = null;
    private pointerStart: {x: number; y: number} | null = null;
    private pointerMoved = false;
    private draggedNode: GraphNode | null = null;
    /** True once the user has panned or zoomed; a resize re-frames the graph only until then, so dragging the nav divider doesn't keep yanking a deliberately chosen viewport back out. */
    private userAdjusted = false;
    /** Theme colours resolved once per resize: canvas takes strings, not classes, and reading custom properties every frame would be a style recalc sixty times a second. */
    private accent = 'rgb(154,132,255)';
    private surface = 'rgb(13,17,23)';
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    constructor() {
        // Same bargain the context rail makes: the warm is paid for by the feature that needs it, when the user asks for it, rather than on every wiki load.
        effect(() => {
            const guildId = this.guildId();
            if (guildId) this.cache.warm(guildId);
        });

        effect(() => {
            const wiki = this.wiki();
            const content = this.cache.content();
            // Positions carry over so the layout relaxes into the new data instead of restarting from the seed ring every time a page is edited elsewhere in the guild.
            const previous = untracked(() => {
                const current = this.model();
                return current ? positionsOf(current) : undefined;
            });
            this.model.set(buildGraph(wiki?.pages ?? [], content, wiki?.categories ?? [], previous));
            // The hovered node is a reference into the model that just got replaced; keeping it would highlight a node that no longer exists.
            this.hovered.set(null);
            this.needsFit = this.needsFit || !this.userAdjusted;
            this.reheat();
        });

        // Re-runs when the canvas appears or is replaced: toggling to the list and back destroys the element, and the observers have to follow it.
        effect(onCleanup => {
            const canvas = this.canvasRef()?.nativeElement;
            if (!canvas) {
                this.ctx = null;
                return;
            }

            const context = canvas.getContext('2d');
            if (!context) {
                // No 2d context at all (a locked-down embedded webview, a lost GPU). The list is still the whole graph, minus the fun.
                this.unavailable.set(true);
                return;
            }
            this.ctx = context;

            const resizeObserver = new ResizeObserver(() => this.resize(canvas));
            resizeObserver.observe(canvas);
            this.resize(canvas);

            // A simulation nobody can see is pure battery. rAF already stops for a hidden tab; this covers the case the tab is visible and the graph simply is not.
            const intersectionObserver = new IntersectionObserver(entries => {
                this.onScreen = entries.some(entry => entry.isIntersecting);
                if (this.onScreen) this.schedule();
                else this.cancel();
            });
            intersectionObserver.observe(this.host.nativeElement);

            this.schedule();

            onCleanup(() => {
                resizeObserver.disconnect();
                intersectionObserver.disconnect();
                this.cancel();
            });
        });

        inject(DestroyRef).onDestroy(() => this.cancel());
    }

    /** A failed warm leaves the cache retryable on purpose; without edges this is a scatter plot. */
    protected retryWarm(): void {
        this.cache.warm(this.guildId());
    }

    protected toggleList(): void {
        this.listMode.update(v => !v);
        this.hovered.set(null);
    }

    protected zoomBy(factor: number): void {
        this.setScale(this.scale() * factor);
        this.schedule();
    }

    protected resetView(): void {
        const model = this.model();
        this.userAdjusted = false;
        // Fitted here and not by reheating the simulation: "fit to view" is an answer to a click, and waiting two seconds of physics for it is not an answer.
        if (model) this.fit(model);
        this.schedule();
    }

    protected onPointerDown(event: PointerEvent): void {
        const canvas = this.canvasRef()?.nativeElement;
        const model = this.model();
        if (!canvas || !model) return;

        canvas.setPointerCapture(event.pointerId);
        this.pointerId = event.pointerId;
        this.pointerStart = {x: event.clientX, y: event.clientY};
        this.pointerMoved = false;

        const index = this.pick(model, this.toGraph(event, canvas));
        if (index !== null) {
            this.draggedNode = model.nodes[index];
            // Pinned for the duration so the springs pull the neighbourhood towards the pointer rather than pulling the grabbed node out of it.
            this.draggedNode.pinned = true;
            this.reheat();
        }
        this.dragging.set(true);
    }

    protected onPointerMove(event: PointerEvent): void {
        const canvas = this.canvasRef()?.nativeElement;
        const model = this.model();
        if (!canvas || !model) return;

        const point = this.toGraph(event, canvas);

        if (this.pointerStart) {
            const distance = Math.hypot(
                event.clientX - this.pointerStart.x,
                event.clientY - this.pointerStart.y,
            );
            if (distance > CLICK_SLOP) this.pointerMoved = true;
        }

        if (this.draggedNode) {
            this.draggedNode.x = point.x;
            this.draggedNode.y = point.y;
            this.reheat();
            return;
        }

        if (this.pointerStart && this.pointerMoved) {
            const scale = this.scale();
            this.camX -= event.movementX / scale;
            this.camY -= event.movementY / scale;
            this.userAdjusted = true;
            this.schedule();
            return;
        }

        const index = this.pick(model, point);
        const next = index === null ? null : model.nodes[index];
        // Only touch the signal on a real change: this fires on every mouse move, and setting a signal to the value it already holds still schedules change detection.
        if (next !== untracked(() => this.hovered())) {
            this.hovered.set(next);
            this.schedule();
        }
    }

    protected onPointerUp(event: PointerEvent): void {
        const canvas = this.canvasRef()?.nativeElement;
        const model = this.model();
        if (canvas && this.pointerId !== null && canvas.hasPointerCapture(this.pointerId)) {
            canvas.releasePointerCapture(this.pointerId);
        }

        if (this.draggedNode) {
            this.draggedNode.pinned = false;
            this.draggedNode = null;
        }

        if (canvas && model && !this.pointerMoved) {
            const index = this.pick(model, this.toGraph(event, canvas));
            if (index !== null) this.open(model.nodes[index].id);
        }

        this.pointerId = null;
        this.pointerStart = null;
        this.pointerMoved = false;
        this.dragging.set(false);
        this.schedule();
    }

    protected onPointerLeave(): void {
        if (this.hovered()) {
            this.hovered.set(null);
            this.schedule();
        }
    }

    protected onWheel(event: WheelEvent): void {
        const canvas = this.canvasRef()?.nativeElement;
        if (!canvas) return;
        event.preventDefault();

        // Zoom about the pointer rather than the centre, so the thing being examined stays under the cursor instead of sliding off the edge.
        const before = this.toGraph(event, canvas);
        this.setScale(this.scale() * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
        const after = this.toGraph(event, canvas);
        this.camX += before.x - after.x;
        this.camY += before.y - after.y;
        this.userAdjusted = true;
        this.schedule();
    }

    protected open(pageId: string): void {
        const page = this.wiki()?.pages.find(p => p.id === pageId);
        if (page) this.openPage.emit(page);
    }

    protected hoveredCategory(): string | undefined {
        const categoryId = this.hovered()?.categoryId;
        if (!categoryId) return undefined;
        return this.wiki()?.categories.find(c => c.id === categoryId)?.name;
    }

    /** Hit tolerance is specified in screen pixels and converted, so a node stays as easy to hit when the graph is zoomed out as when it fills the canvas. */
    private pick(model: GraphModel, point: {x: number; y: number}): number | null {
        return hitTest(model, point.x, point.y, 6 / this.scale());
    }

    private setScale(value: number): void {
        this.scale.set(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)));
    }

    private reheat(): void {
        this.alpha = Math.max(this.alpha, ALPHA_REHEAT);
        this.schedule();
    }

    private schedule(): void {
        if (!this.onScreen || this.frame !== undefined || !this.ctx) return;
        this.frame = requestAnimationFrame(this.loop);
    }

    private cancel(): void {
        if (this.frame !== undefined) {
            cancelAnimationFrame(this.frame);
            this.frame = undefined;
        }
    }

    /** One frame: step, cool, draw, and schedule the next only while there is still movement; a settled graph costs nothing until something asks for a repaint. */
    private readonly loop = (): void => {
        this.frame = undefined;
        const model = untracked(() => this.model());
        if (!this.ctx || !model || !this.onScreen) return;

        if (this.alpha > ALPHA_MIN) {
            stepSimulation(model, this.alpha);
            this.alpha = coolAlpha(this.alpha);
            this.schedule();
        } else if (this.needsFit) {
            // Fitting mid-layout would chase the nodes around; fitting once they stop is a single decisive move to the right framing.
            this.fit(model);
        }

        this.draw(model);
    };

    private resize(canvas: HTMLCanvasElement): void {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        this.viewWidth = rect.width;
        this.viewHeight = rect.height;
        // Everything below draws in CSS pixels; the device ratio lives here and nowhere else.
        this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.readTheme();
        this.needsFit = this.needsFit || !this.userAdjusted;
        this.schedule();
    }

    /** Canvas takes colour strings, so the theme tokens are resolved here rather than hard-coded, so `ThemeService`, which overrides these custom properties at runtime, still reaches the graph. */
    private readTheme(): void {
        const styles = getComputedStyle(this.host.nativeElement);
        this.accent = styles.getPropertyValue('--color-brand-dim').trim() || this.accent;
        this.surface = styles.getPropertyValue('--color-app-bg').trim() || this.surface;
    }

    private fit(model: GraphModel): void {
        if (!model.nodes.length || !this.viewWidth || !this.viewHeight) return;
        const bounds = boundsOf(model);
        const width = Math.max(1, bounds.maxX - bounds.minX);
        const height = Math.max(1, bounds.maxY - bounds.minY);
        this.setScale(Math.min(this.viewWidth / width, this.viewHeight / height));
        this.camX = (bounds.minX + bounds.maxX) / 2;
        this.camY = (bounds.minY + bounds.maxY) / 2;
        this.needsFit = false;
    }

    private toGraph(event: {clientX: number; clientY: number}, canvas: HTMLCanvasElement) {
        const rect = canvas.getBoundingClientRect();
        const scale = this.scale();
        return {
            x: (event.clientX - rect.left - rect.width / 2) / scale + this.camX,
            y: (event.clientY - rect.top - rect.height / 2) / scale + this.camY,
        };
    }

    private draw(model: GraphModel): void {
        const ctx = this.ctx;
        if (!ctx) return;

        const scale = this.scale();
        const hovered = untracked(() => this.hovered());
        const hoveredIndex = hovered ? model.nodes.indexOf(hovered) : -1;
        const highlighted = new Set<number>();
        if (hoveredIndex >= 0) {
            highlighted.add(hoveredIndex);
            for (const neighbour of model.neighbours[hoveredIndex]) highlighted.add(neighbour);
        }

        ctx.clearRect(0, 0, this.viewWidth, this.viewHeight);
        ctx.save();
        ctx.translate(this.viewWidth / 2, this.viewHeight / 2);
        ctx.scale(scale, scale);
        ctx.translate(-this.camX, -this.camY);

        ctx.lineWidth = 1 / scale;
        for (const edge of model.edges) {
            const a = model.nodes[edge.a];
            const b = model.nodes[edge.b];
            const lit = hoveredIndex >= 0 && (edge.a === hoveredIndex || edge.b === hoveredIndex);
            if (hoveredIndex >= 0 && !lit) {
                ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            } else if (lit) {
                ctx.strokeStyle = this.accent;
            } else {
                ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            }
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        for (let i = 0; i < model.nodes.length; i++) {
            const node = model.nodes[i];
            const radius = nodeRadius(node);
            const dimmed = hoveredIndex >= 0 && !highlighted.has(i);
            const color = nodeColor(node.colorIndex, this.accent);

            if (i === hoveredIndex) {
                // A halo rather than a bigger dot: growing the node moves its neighbours' labels.
                ctx.globalAlpha = 0.22;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, radius + 7 / scale, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.globalAlpha = dimmed ? 0.2 : 1;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = dimmed ? 0.15 : 0.85;
            ctx.strokeStyle = this.surface;
            ctx.lineWidth = 1.5 / scale;
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        ctx.font = `${11 / scale}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < model.nodes.length; i++) {
            const node = model.nodes[i];
            const always = highlighted.has(i);
            const byZoom =
                scale >= LABEL_ALL_SCALE || (scale >= LABEL_SCALE && node.degree >= LABEL_MIN_DEGREE);
            if (!always && (!byZoom || hoveredIndex >= 0)) continue;
            ctx.fillStyle = always && hoveredIndex >= 0 ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.5)';
            ctx.fillText(truncate(node.title), node.x, node.y + nodeRadius(node) + 4 / scale);
        }

        ctx.restore();
    }
}

/** Canvas has no ellipsis. Long titles would otherwise draw straight over their neighbours. */
function truncate(title: string): string {
    return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}
