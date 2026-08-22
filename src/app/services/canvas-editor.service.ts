import {computed, inject, Injectable, signal} from '@angular/core';
import {CanvasVisibility, CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {definitionFor} from '../components/profile-canvas/widget-registry';
import {
    CANVAS_COLUMNS,
    dropAt as dropAtCell,
    Footprint,
    MAX_CARD_WIDGETS,
    MAX_WIDGETS,
    normalise,
    snapFootprint,
} from '../models/profile-canvas';
import {CanvasHistoryKind, ProfileEditHistoryService} from './profile-edit-history.service';

/** Unique enough for a draft; the server assigns the real id on save. */
function draftId(): string {
    return `draft-${Math.random().toString(36).slice(2, 10)}`;
}

/** The arrangement being edited. Device state: a second window may be mid-edit on something else. */
@Injectable({providedIn: 'root'})
export class CanvasEditorService {
    private readonly history = inject(ProfileEditHistoryService);

    private readonly baseline = signal<string>('');
    private readonly current = signal<ProfileCanvasDto | null>(null);

    readonly draft = this.current.asReadonly();

    readonly dirty = computed(() => {
        const canvas = this.current();
        return !!canvas && JSON.stringify(canvas.widgets) !== this.baseline();
    });

    begin(canvas: ProfileCanvasDto): void {
        const packed = normalise(canvas);
        this.current.set(packed);
        this.baseline.set(JSON.stringify(packed.widgets));
    }

    /** Reverts every widget to the last-saved baseline in one step. */
    discard(): void {
        if (!this.current()) return;
        this.write(JSON.parse(this.baseline()) as CanvasWidgetDto[]);
    }

    /** Lands a widgets array from a history entry. Unlike every method below, this never
     * pushes a new entry: undo and redo replay history, they do not extend it. */
    restore(widgets: CanvasWidgetDto[]): void {
        this.write(widgets);
    }

    canInsert(type: string): boolean {
        const canvas = this.current();
        const definition = definitionFor(type);
        if (!canvas || !definition) return false;
        if (canvas.widgets.length >= MAX_WIDGETS) return false;
        return canvas.widgets.filter(widget => widget.type === type).length < definition.max;
    }

    /** Returns the widget it created, or null when the insert was refused. */
    insert(type: string): CanvasWidgetDto | null {
        const canvas = this.current();
        const definition = definitionFor(type);
        if (!canvas || !definition || !this.canInsert(type)) return null;

        const footprint = definition.footprints[0];
        const widget: CanvasWidgetDto = {
            id: draftId(),
            type,
            x: 0,
            y: 0, // write()'s restamp assigns the real position; this value is never read.
            w: footprint.w,
            h: footprint.h,
            visibility: 'everyone',
            card: false,
            config: definition.defaultConfig(),
        };
        this.write([...canvas.widgets, widget], {kind: 'add', widgetType: type});
        return this.current()?.widgets.find(w => w.id === widget.id) ?? null;
    }

    remove(id: string): void {
        const canvas = this.current();
        const widget = canvas?.widgets.find(w => w.id === id);
        if (!canvas || !widget) return;
        this.write(
            canvas.widgets.filter(w => w.id !== id),
            {kind: 'remove', widgetType: widget.type},
        );
    }

    /** Target is a grid cell, not a list index. `dropAtCell` returns the same array reference
     * when `id` is unknown, which is the signal to skip the write rather than restamp a no-op. */
    dropAt(id: string, target: {x: number; y: number}): void {
        const canvas = this.current();
        if (!canvas) return;
        const widget = canvas.widgets.find(w => w.id === id);
        const next = dropAtCell(canvas.widgets, id, target, CANVAS_COLUMNS);
        if (!widget || next === canvas.widgets) return;
        this.write(next, {kind: 'move', widgetType: widget.type});
    }

    /** Reading order is array order, so a move is an array move and reflow does the rest. */
    move(id: string, delta: number): void {
        const canvas = this.current();
        if (!canvas) return;

        const from = canvas.widgets.findIndex(widget => widget.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= canvas.widgets.length) return;

        const widgetType = canvas.widgets[from].type;
        const widgets = [...canvas.widgets];
        const [moved] = widgets.splice(from, 1);
        widgets.splice(to, 0, moved);
        this.write(widgets, {kind: 'move', widgetType});
    }

    resize(id: string, footprint: Footprint): void {
        this.patch(id, 'resize', () => snapFootprint(footprint.w, footprint.h));
    }

    setVisibility(id: string, visibility: CanvasVisibility): void {
        this.patch(id, 'visibility', () => ({visibility}));
    }

    setCard(id: string, card: boolean): void {
        const canvas = this.current();
        const widget = canvas?.widgets.find(w => w.id === id);
        if (!canvas || !widget) return;

        const already = canvas.widgets.filter(w => w.card && w.id !== id).length;
        if (card && already >= MAX_CARD_WIDGETS) return;
        this.write(
            canvas.widgets.map(w => (w.id === id ? {...w, card} : w)),
            {kind: 'card', widgetType: widget.type},
        );
    }

    patchConfig(id: string, patch: Record<string, unknown>): void {
        this.patch(id, 'config', widget => ({
            config: {...(widget.config as Record<string, unknown>), ...patch},
        }));
    }

    private patch(
        id: string,
        kind: CanvasHistoryKind,
        change: (widget: CanvasWidgetDto) => Partial<CanvasWidgetDto>,
    ): void {
        const canvas = this.current();
        const widget = canvas?.widgets.find(w => w.id === id);
        if (!canvas || !widget) return;
        this.write(
            canvas.widgets.map(w => (w.id === id ? {...w, ...change(w)} : w)),
            {kind, widgetType: widget.type},
        );
    }

    /** Every mutation lands here, so the draft is never an arrangement the grid could not draw.
     * `history` is omitted by `restore()`: undo and redo replay a past entry, they must not push
     * a new one back onto the stack they are draining. */
    private write(widgets: CanvasWidgetDto[], history?: {kind: CanvasHistoryKind; widgetType: string}): void {
        const canvas = this.current();
        if (!canvas) return;
        // reflow's presort keys off y, not array position, so array order only becomes
        // reading order if y is restamped from the array index first.
        const ordered = widgets.slice(0, MAX_WIDGETS).map((widget, index) => ({...widget, x: 0, y: index}));
        const next = normalise({...canvas, widgets: ordered});
        if (history && JSON.stringify(next.widgets) !== JSON.stringify(canvas.widgets)) {
            this.history.pushCanvas(history.kind, history.widgetType, canvas.widgets, next.widgets);
        }
        this.current.set(next);
    }
}
