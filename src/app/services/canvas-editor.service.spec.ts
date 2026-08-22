import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {CanvasEditorService} from './canvas-editor.service';
import {ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
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
        for (let i = 0; i < MAX_WIDGETS + 3; i++) editor.insert('photo');
        expect(editor.draft()?.widgets.length).toBeLessThanOrEqual(MAX_WIDGETS);
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
        const only = editor.draft()!.widgets[0].id;
        editor.move(only, -1);
        editor.move(only, 1);
        expect(editor.draft()!.widgets[0].id).toBe(only);
    });

    it('resize snaps to a legal footprint', () => {
        editor.insert('quote');
        const id = editor.draft()!.widgets[0].id;
        editor.resize(id, {w: 4, h: 1});
        expect(editor.draft()!.widgets[0]).toMatchObject({w: 4, h: 1});
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
