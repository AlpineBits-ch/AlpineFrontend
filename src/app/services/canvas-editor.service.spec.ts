import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {CanvasEditorService} from './canvas-editor.service';
import {CanvasWidgetDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {emptyCanvas, MAX_WIDGETS} from '../models/profile-canvas';

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

        editor.move(ids[2], 1);
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

    it('setCard lets a widget already flagged toggle off and back on', () => {
        editor.insert('quote');
        editor.insert('photo');
        const ids = editor.draft()!.widgets.map(w => w.id);
        editor.setCard(ids[0], true);
        editor.setCard(ids[1], true);

        editor.setCard(ids[0], false);
        editor.setCard(ids[0], true);

        expect(editor.draft()!.widgets.find(w => w.id === ids[0])!.card).toBe(true);
        expect(editor.draft()!.widgets.filter(w => w.card)).toHaveLength(2);
    });

    it('dirty stays false when a mutation is a genuine no-op', () => {
        editor.insert('quote');
        editor.begin(editor.draft()!);
        const id = editor.draft()!.widgets[0].id;
        editor.setVisibility(id, 'everyone');
        expect(editor.dirty()).toBe(false);
    });

    it('discard returns to the baseline and goes clean', () => {
        editor.insert('quote');
        editor.discard();
        expect(editor.draft()?.widgets).toEqual([]);
        expect(editor.dirty()).toBe(false);
    });

    it('begin replaces the baseline, so a saved canvas is clean again', () => {
        editor.insert('quote');
        editor.begin(editor.draft()!);
        expect(editor.dirty()).toBe(false);
    });
});
