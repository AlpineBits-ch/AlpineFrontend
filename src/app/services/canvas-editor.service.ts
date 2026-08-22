import {computed, inject, Injectable, signal} from '@angular/core';
import {CanvasVisibility, CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {definitionFor} from '../components/profile-canvas/widget-registry';
import {
    CANVAS_COLUMNS,
    dropAt as dropAtCell,
    Footprint,
    isSpacer,
    MAX_CARD_WIDGETS,
    MAX_WIDGETS,
    normalise,
    snapFootprint,
    trimTrailingSpacers,
} from '../models/profile-canvas';
import {CanvasHistoryKind, ProfileEditHistoryService} from './profile-edit-history.service';
import {AUTOSAVE_DEBOUNCE_MS} from '../core/autosave';

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

    /** Keyed on `${widgetId}:${fieldKey}`; a burst's own commit timer, live only while that
     * burst is open in `history`. */
    private readonly configTextTimers = new Map<string, ReturnType<typeof setTimeout>>();

    readonly draft = this.current.asReadonly();

    readonly dirty = computed(() => {
        const canvas = this.current();
        return !!canvas && JSON.stringify(canvas.widgets) !== this.baseline();
    });

    /** A same-profile call is a re-baseline (a save's success echo, a store echo catching up),
     * not a profile switch, and must not silently drop a text burst still in its debounce
     * window: commit it first, the same entry the debounce timer would have pushed. */
    begin(canvas: ProfileCanvasDto): void {
        const packed = normalise(canvas);
        const pendingKeys = [...this.configTextTimers.keys()];
        if (this.current()?.profileId === packed.profileId) {
            for (const key of pendingKeys) {
                clearTimeout(this.configTextTimers.get(key));
                this.configTextTimers.delete(key);
                this.commitConfigText(key);
            }
        } else {
            for (const key of pendingKeys) {
                clearTimeout(this.configTextTimers.get(key));
                this.history.discardBurst(key);
            }
            this.configTextTimers.clear();
        }
        this.current.set(packed);
        this.baseline.set(JSON.stringify(packed.widgets));
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
        if (canvas.widgets.filter(widget => !isSpacer(widget)).length >= MAX_WIDGETS) return false;
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

        const already = canvas.widgets.filter(w => w.card).length;
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

    /** Same write as `patchConfig`, without the history push. For a config change tied to a
     * side effect that already happened server-side and cannot itself be undone, such as an
     * image delete: undo must never put the reference back once the file is gone. */
    patchConfigSilently(id: string, patch: Record<string, unknown>): void {
        const canvas = this.current();
        const widget = canvas?.widgets.find(w => w.id === id);
        if (!canvas || !widget) return;
        this.write(
            canvas.widgets.map(w =>
                w.id === id ? {...w, config: {...(w.config as Record<string, unknown>), ...patch}} : w,
            ),
        );
    }

    /** For a config field driven by typing rather than a discrete choice. Applies every
     * keystroke to the draft immediately, same as `patchConfig`, but defers the history push to
     * `history`'s burst latch, keyed per widget and field so unrelated bursts never coalesce. */
    patchConfigText(id: string, fieldKey: string, patch: Record<string, unknown>): void {
        const canvas = this.current();
        const widget = canvas?.widgets.find(w => w.id === id);
        if (!canvas || !widget) return;

        const key = `${id}:${fieldKey}`;
        this.history.noteBurst(key, {widgetType: widget.type, before: canvas.widgets});
        this.write(
            canvas.widgets.map(w =>
                w.id === id ? {...w, config: {...(w.config as Record<string, unknown>), ...patch}} : w,
            ),
        );

        clearTimeout(this.configTextTimers.get(key));
        this.configTextTimers.set(
            key,
            setTimeout(() => this.commitConfigText(key), AUTOSAVE_DEBOUNCE_MS),
        );
    }

    private commitConfigText(key: string): void {
        this.configTextTimers.delete(key);
        const canvas = this.current();
        this.history.commitBurst<{widgetType: string; before: CanvasWidgetDto[]}, CanvasWidgetDto[] | undefined>(
            key,
            canvas?.widgets,
            (pending, after) => {
                if (!after || JSON.stringify(after) === JSON.stringify(pending.before)) return null;
                return {
                    domain: 'canvas',
                    kind: 'config',
                    widgetType: pending.widgetType,
                    before: pending.before,
                    after,
                };
            },
        );
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
        // reading order if y is restamped from the array index first. Real widgets and spacers
        // are never sliced together here: normalise caps each of them separately.
        const ordered = widgets.map((widget, index) => ({...widget, x: 0, y: index}));
        const packed = normalise({...canvas, widgets: ordered});
        const next = {...packed, widgets: trimTrailingSpacers(packed.widgets)};
        if (history && JSON.stringify(next.widgets) !== JSON.stringify(canvas.widgets)) {
            this.history.pushCanvas(history.kind, history.widgetType, canvas.widgets, next.widgets);
        }
        this.current.set(next);
    }
}
