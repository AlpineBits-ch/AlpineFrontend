import {computed, Injectable, signal} from '@angular/core';
import {CanvasVisibility, CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {definitionFor} from '../components/profile-canvas/widget-registry';
import {Footprint, MAX_CARD_WIDGETS, MAX_WIDGETS, normalise, snapFootprint} from '../models/profile-canvas';

/** Unique enough for a draft; the server assigns the real id on save. */
function draftId(): string {
    return `draft-${Math.random().toString(36).slice(2, 10)}`;
}

/** The arrangement being edited. Device state: a second window may be mid-edit on something else. */
@Injectable({providedIn: 'root'})
export class CanvasEditorService {
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

    discard(): void {
        if (!this.current()) return;
        this.write(JSON.parse(this.baseline()) as CanvasWidgetDto[]);
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
        this.write([...canvas.widgets, widget]);
        return this.current()?.widgets.find(w => w.id === widget.id) ?? null;
    }

    remove(id: string): void {
        const canvas = this.current();
        if (!canvas) return;
        this.write(canvas.widgets.filter(widget => widget.id !== id));
    }

    /** Reading order is array order, so a move is an array move and reflow does the rest. */
    move(id: string, delta: number): void {
        const canvas = this.current();
        if (!canvas) return;

        const from = canvas.widgets.findIndex(widget => widget.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= canvas.widgets.length) return;

        const widgets = [...canvas.widgets];
        const [moved] = widgets.splice(from, 1);
        widgets.splice(to, 0, moved);
        this.write(widgets);
    }

    resize(id: string, footprint: Footprint): void {
        this.patch(id, () => snapFootprint(footprint.w, footprint.h));
    }

    setVisibility(id: string, visibility: CanvasVisibility): void {
        this.patch(id, () => ({visibility}));
    }

    setCard(id: string, card: boolean): void {
        const canvas = this.current();
        if (!canvas) return;

        const already = canvas.widgets.filter(widget => widget.card && widget.id !== id).length;
        if (card && already >= MAX_CARD_WIDGETS) return;
        this.patch(id, () => ({card}));
    }

    patchConfig(id: string, patch: Record<string, unknown>): void {
        this.patch(id, widget => ({
            config: {...(widget.config as Record<string, unknown>), ...patch},
        }));
    }

    private patch(id: string, change: (widget: CanvasWidgetDto) => Partial<CanvasWidgetDto>): void {
        const canvas = this.current();
        if (!canvas) return;
        this.write(
            canvas.widgets.map(widget => (widget.id === id ? {...widget, ...change(widget)} : widget)),
        );
    }

    /** Every mutation lands here, so the draft is never an arrangement the grid could not draw. */
    private write(widgets: CanvasWidgetDto[]): void {
        const canvas = this.current();
        if (!canvas) return;
        // reflow's presort keys off y, not array position, so array order only becomes
        // reading order if y is restamped from the array index first.
        const ordered = widgets.slice(0, MAX_WIDGETS).map((widget, index) => ({...widget, x: 0, y: index}));
        this.current.set(normalise({...canvas, widgets: ordered}));
    }
}
