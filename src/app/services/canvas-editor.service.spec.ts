import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CanvasEditorService} from './canvas-editor.service';
import {CanvasHistoryEntry, ProfileEditHistoryService} from './profile-edit-history.service';
import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {emptyCanvas, MAX_SPACERS, MAX_WIDGETS, SPACER_TYPE} from '../models/profile-canvas';
import {AUTOSAVE_DEBOUNCE_MS} from '../features/discovery/listing-editor/listing-editor.component';

function service(): CanvasEditorService {
    TestBed.configureTestingModule({});
    return TestBed.inject(CanvasEditorService);
}

function started(canvas: ProfileCanvasDto = emptyCanvas('p1')): CanvasEditorService {
    const editor = service();
    editor.begin(canvas);
    return editor;
}

function seedWidget(id: string, y: number): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y,
        w: 1,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
    };
}

describe('CanvasEditorService', () => {
    let editor: CanvasEditorService;

    beforeEach(() => {
        editor = started();
    });

    it('starts clean', () => {
        expect(editor.dirty()).toBe(false);
        expect(editor.draft()?.widgets).toEqual([]);
    });

    it('insert adds a widget of that type with its default config', () => {
        editor.insert('quote');
        expect(editor.draft()?.widgets).toHaveLength(1);
        expect(editor.draft()?.widgets[0].type).toBe('quote');
        expect(editor.draft()?.widgets[0].config).toEqual({text: '', attribution: ''});
        expect(editor.dirty()).toBe(true);
    });

    it('insert uses the first footprint the registry offers', () => {
        editor.insert('quote');
        expect(editor.draft()?.widgets[0]).toMatchObject({w: 2, h: 1});
    });

    it('refuses a type the registry does not know', () => {
        editor.insert('from-the-future');
        expect(editor.draft()?.widgets).toHaveLength(0);
    });

    it('refuses to insert past the cap', () => {
        // Registry per-type maxes sum to less than MAX_WIDGETS, so insert() alone can never
        // reach it. Seed a full draft directly to exercise the global cap on its own, with a
        // type ('marquee') nowhere near its own max so only the cap can be refusing it.
        const widgets = Array.from({length: MAX_WIDGETS}, (_, i) => seedWidget(`seed-${i}`, i));
        editor.begin({...emptyCanvas('p1'), widgets});
        expect(editor.draft()!.widgets).toHaveLength(MAX_WIDGETS);

        expect(editor.canInsert('marquee')).toBe(false);
        editor.insert('marquee');
        expect(editor.draft()!.widgets.filter(w => w.type === 'marquee')).toHaveLength(0);
        expect(editor.draft()!.widgets).toHaveLength(MAX_WIDGETS);
    });

    it('canInsert goes false once a type is at its max', () => {
        editor.insert('marquee');
        expect(editor.canInsert('marquee')).toBe(false);
        expect(editor.canInsert('quote')).toBe(true);
    });

    it('canInsert is true with six real widgets and many spacers present', () => {
        const reals = Array.from({length: 6}, (_, i) => seedWidget(`w${i}`, i));
        const spacers = Array.from({length: 15}, (_, i) => ({
            ...seedWidget(`s${i}`, 6 + i),
            type: SPACER_TYPE,
        }));
        editor.begin({...emptyCanvas('p1'), widgets: [...reals, ...spacers]});

        expect(editor.canInsert('marquee')).toBe(true);
    });

    it('a drag that pushes the mixed array past the cap keeps the dragged widget', () => {
        const widgets = Array.from({length: MAX_WIDGETS}, (_, i) => seedWidget(`seed-${i}`, i));
        editor.begin({...emptyCanvas('p1'), widgets});
        const draggedId = editor.draft()!.widgets[MAX_WIDGETS - 1].id;

        editor.dropAt(draggedId, {x: 0, y: 5});

        expect(editor.draft()!.widgets.some(w => w.id === draggedId)).toBe(true);
    });

    it('repeated drags cap the spacer count instead of growing without bound, and trailing spacers do not survive a later write', () => {
        editor.insert('local-time');
        const id = editor.draft()!.widgets[0].id;

        for (let row = 1; row <= 25; row++) {
            editor.dropAt(id, {x: 0, y: row});
        }

        expect(editor.draft()!.widgets.some(w => w.id === id)).toBe(true);
        const spacerCount = editor.draft()!.widgets.filter(w => w.type === SPACER_TYPE).length;
        expect(spacerCount).toBeLessThanOrEqual(MAX_SPACERS);

        editor.remove(id);
        expect(editor.draft()!.widgets.some(w => w.type === SPACER_TYPE)).toBe(false);
    });

    it('remove drops the widget', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.remove(id);
        expect(editor.draft()?.widgets).toHaveLength(0);
    });

    it('move reorders in reading order', () => {
        editor.insert('quote');
        editor.insert('photo');
        const second = editor.draft()!.widgets[1].id;

        editor.move(second, -1);
        expect(editor.draft()!.widgets[0].id).toBe(second);
    });

    it('move past either end does nothing', () => {
        editor.insert('quote');
        editor.insert('photo');
        editor.insert('infobox');
        const ids = editor.draft()!.widgets.map(w => w.id);

        editor.move(ids[0], -1);
        expect(editor.draft()!.widgets.map(w => w.id)).toEqual(ids);

        // A large delta on a middle widget: splice would otherwise clamp the target and still
        // move it to the end, so this is the case that actually exercises the upper-bound guard.
        editor.move(ids[1], 5);
        expect(editor.draft()!.widgets.map(w => w.id)).toEqual(ids);
    });

    it('resize snaps an illegal footprint down to the nearest legal one', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.resize(id, {w: 3, h: 3});
        expect(editor.draft()!.widgets[0]).toMatchObject({w: 2, h: 2});
    });

    it('setVisibility changes a widget visibility', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.setVisibility(id, 'friends');
        expect(editor.draft()!.widgets[0].visibility).toBe('friends');
    });

    it('patchConfig merges rather than replacing', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.patchConfig(id, {text: 'hello'});
        expect(editor.draft()!.widgets[0].config).toEqual({text: 'hello', attribution: ''});
    });

    it('setCard refuses a third card widget', () => {
        editor.insert('quote');
        editor.insert('photo');
        editor.insert('infobox');
        const ids = editor.draft()!.widgets.map(w => w.id);
        editor.setCard(ids[0], true);
        editor.setCard(ids[1], true);
        editor.setCard(ids[2], true);

        expect(editor.draft()!.widgets.filter(w => w.card)).toHaveLength(2);
    });

    it('dirty stays false when a mutation is a genuine no-op', () => {
        editor.insert('quote');
        editor.begin(editor.draft()!);
        const id = editor.draft()!.widgets[0].id;
        editor.setVisibility(id, 'everyone');
        expect(editor.dirty()).toBe(false);
    });

    it('begin replaces the baseline, so a saved canvas is clean again', () => {
        editor.insert('quote');
        editor.begin(editor.draft()!);
        expect(editor.dirty()).toBe(false);
    });

    it('dropAt onto an occupied cell reorders with no spacers', () => {
        editor.insert('quote'); // 2x1, lands at (0,0)
        editor.insert('local-time'); // 1x1, lands at (2,0)
        const [a, b] = editor.draft()!.widgets;

        editor.dropAt(b.id, {x: 0, y: 0});

        const widgets = editor.draft()!.widgets;
        expect(widgets.map(w => w.id)).toEqual([b.id, a.id]);
        expect(widgets.some(w => w.type === 'spacer')).toBe(false);
    });

    it('dropAt past the content inserts spacers and lands the widget at the target', () => {
        editor.insert('marquee'); // 4x1, fills row 0
        editor.insert('local-time'); // 1x1, lands at (0,1)
        const [, moved] = editor.draft()!.widgets;

        editor.dropAt(moved.id, {x: 2, y: 2});

        const widgets = editor.draft()!.widgets;
        const landed = widgets.find(w => w.id === moved.id)!;
        expect(landed).toMatchObject({x: 2, y: 2});
        expect(widgets.some(w => w.type === 'spacer')).toBe(true);
    });

    it('dropAt marks the draft dirty', () => {
        editor.insert('marquee');
        editor.insert('local-time');
        const [, moved] = editor.draft()!.widgets;
        editor.begin(editor.draft()!);

        editor.dropAt(moved.id, {x: 2, y: 2});

        expect(editor.dirty()).toBe(true);
    });

    it('dropAt does nothing for an id that is not in the draft', () => {
        editor.insert('quote');
        const before = editor.draft();

        editor.dropAt('nope', {x: 0, y: 0});

        expect(editor.draft()).toBe(before);
    });

    describe('history', () => {
        it('insert pushes an add entry naming the widget type', () => {
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');

            const entry = history.undo();
            expect(entry).toMatchObject({domain: 'canvas', kind: 'add', widgetType: 'quote'});
            expect((entry as {before: CanvasWidgetDto[]}).before).toEqual([]);
        });

        it("remove pushes a remove entry naming the removed widget's type", () => {
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            history.undo(); // discard the insert entry, isolate remove
            const id = editor.draft()!.widgets[0].id;

            editor.remove(id);

            const entry = history.undo();
            expect(entry).toMatchObject({domain: 'canvas', kind: 'remove', widgetType: 'quote'});
        });

        it('a mutation refused before it can change anything pushes nothing', () => {
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('from-the-future'); // unknown type, refused
            expect(history.canUndo()).toBe(false);
        });

        it('a mutation that is a genuine no-op pushes nothing', () => {
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            history.undo();
            const id = editor.draft()!.widgets[0].id;

            editor.setVisibility(id, 'everyone'); // already 'everyone'

            expect(history.canUndo()).toBe(false);
        });

        it('restore lands a widgets array without pushing a new entry', () => {
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            history.reset();

            editor.restore([]);

            expect(editor.draft()?.widgets).toEqual([]);
            expect(history.canUndo()).toBe(false);
        });

        it('patchConfig, a discrete change, pushes its own entry per call', () => {
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            history.undo(); // discard the insert entry, isolate patchConfig

            const id = editor.draft()!.widgets[0].id;
            editor.patchConfig(id, {attribution: 'Ada'});
            editor.patchConfig(id, {attribution: 'Ada L'});

            history.undo();
            expect(history.canUndo()).toBe(true); // the first call's entry is still there
            history.undo();
            expect(history.canUndo()).toBe(false);
        });
    });

    describe('patchConfigText', () => {
        afterEach(() => vi.useRealTimers());

        it('coalesces a burst into one entry whose before is the pre-burst value', () => {
            vi.useFakeTimers();
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            history.undo();
            const id = editor.draft()!.widgets[0].id;

            editor.patchConfigText(id, 'text', {text: 'a'});
            editor.patchConfigText(id, 'text', {text: 'ab'});
            editor.patchConfigText(id, 'text', {text: 'abc'});
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);

            expect(history.canUndo()).toBe(true);
            const entry = history.undo() as CanvasHistoryEntry;
            expect(history.canUndo()).toBe(false);
            expect((entry.before[0].config as {text: string}).text).toBe('');
            expect((entry.after[0].config as {text: string}).text).toBe('abc');
        });

        it('keys the burst per widget: a second widget commits a separate entry', () => {
            vi.useFakeTimers();
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            editor.insert('quote');
            history.reset();
            const [first, second] = editor.draft()!.widgets;

            editor.patchConfigText(first.id, 'text', {text: 'one'});
            editor.patchConfigText(second.id, 'text', {text: 'two'});
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);

            history.undo();
            expect(history.canUndo()).toBe(true);
            history.undo();
            expect(history.canUndo()).toBe(false);
        });

        it('keys the burst per field: a second field on the same widget commits a separate entry', () => {
            vi.useFakeTimers();
            const history = TestBed.inject(ProfileEditHistoryService);
            editor.insert('quote');
            history.reset();
            const id = editor.draft()!.widgets[0].id;

            editor.patchConfigText(id, 'text', {text: 'hello'});
            editor.patchConfigText(id, 'attribution', {attribution: 'Ada'});
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);

            history.undo();
            expect(history.canUndo()).toBe(true);
            history.undo();
            expect(history.canUndo()).toBe(false);
        });
    });
});
