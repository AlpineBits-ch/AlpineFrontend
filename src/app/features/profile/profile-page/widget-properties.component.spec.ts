import {TestBed} from '@angular/core/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of, Subject, throwError} from 'rxjs';
import {WidgetPropertiesComponent} from './widget-properties.component';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {ProfileEditHistoryService} from '../../../services/profile-edit-history.service';
import {emptyCanvas} from '../../../models/profile-canvas';
import {AUTOSAVE_DEBOUNCE_MS} from '../../../core/autosave';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';

function setup(type: string, api: Partial<ProfileCanvasApiService> = {}) {
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            {provide: ProfileCanvasApiService, useValue: api},
            // ToastService -> MessageService; removeImage reports a failed delete through it.
            MessageService,
        ],
    });
    const editor = TestBed.inject(CanvasEditorService);
    editor.begin(emptyCanvas('p1'));
    editor.insert(type);

    const fixture = TestBed.createComponent(WidgetPropertiesComponent);
    fixture.componentRef.setInput('widget', editor.draft()!.widgets[0]);
    fixture.detectChanges();
    return {fixture, editor};
}

/** Re-binds the widget input from the editor's current draft and re-renders, standing in for the live parent binding the shell provides. */
function resync(
    fixture: ReturnType<typeof setup>['fixture'],
    editor: ReturnType<typeof setup>['editor'],
    id: string,
) {
    const widget = editor.draft()!.widgets.find(w => w.id === id);
    if (widget) fixture.componentRef.setInput('widget', widget);
    fixture.detectChanges();
}

describe('WidgetPropertiesComponent', () => {
    it('draws one control per declared field', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="field"]')).toHaveLength(2);
    });

    it('typing into a text field patches the config', () => {
        const {fixture, editor} = setup('quote');
        const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
        input.value = 'a new line';
        input.dispatchEvent(new Event('input'));

        expect((editor.draft()!.widgets[0].config as {text: string}).text).toBe('a new line');
    });

    it('editing one field does not blank its siblings', () => {
        const {fixture, editor} = setup('quote');
        const widgetId = editor.draft()!.widgets[0].id;
        editor.patchConfig(widgetId, {attribution: 'Alice'});
        resync(fixture, editor, widgetId);

        const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
        textarea.value = 'changed text';
        textarea.dispatchEvent(new Event('input'));

        const config = editor.draft()!.widgets[0].config as {text: string; attribution: string};
        expect(config.text).toBe('changed text');
        expect(config.attribution).toBe('Alice');
    });

    it('offers every footprint the registry allows for the type', () => {
        const {fixture} = setup('quote');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="footprint"]')).toHaveLength(3);
    });

    it('draws the three visibility choices and wires each button to its own value', () => {
        const {fixture, editor} = setup('quote');
        const buttons: HTMLButtonElement[] = Array.from(
            fixture.nativeElement.querySelectorAll('[data-testid="visibility"]'),
        );
        const expected = ['everyone', 'friends', 'mutuals'];
        expect(buttons).toHaveLength(3);

        buttons.forEach((button, i) => {
            button.click();
            expect(editor.draft()!.widgets[0].visibility).toBe(expected[i]);
        });
    });

    it('draws no field controls for mutuals but still renders footprint, visibility and card controls', () => {
        const {fixture} = setup('mutuals');
        expect(fixture.nativeElement.querySelectorAll('[data-testid="field"]')).toHaveLength(0);
        expect(fixture.nativeElement.querySelectorAll('[data-testid="footprint"]').length).toBeGreaterThan(0);
        expect(fixture.nativeElement.querySelectorAll('[data-testid="visibility"]')).toHaveLength(3);
        expect(fixture.nativeElement.querySelector('input[type="checkbox"]')).toBeTruthy();
    });

    describe('rows', () => {
        it('renders an empty cell, not the string "undefined", when a stored row is missing a column', () => {
            const {fixture, editor} = setup('open-to');
            const widgetId = editor.draft()!.widgets[0].id;
            editor.patchConfig(widgetId, {items: [{label: 'x'}]});
            resync(fixture, editor, widgetId);

            const row: HTMLElement = fixture.nativeElement.querySelector('[data-testid="row"]');
            const inputs: HTMLInputElement[] = Array.from(row.querySelectorAll('input'));
            expect(inputs[1].value).toBe('');
        });

        it('adds a row, edits one cell of the second row, then removes the first, leaving the rest untouched', () => {
            const {fixture, editor} = setup('open-to');
            const widgetId = editor.draft()!.widgets[0].id;

            const addRow = () => {
                (fixture.nativeElement.querySelector('[data-testid="add-row"]') as HTMLButtonElement).click();
                resync(fixture, editor, widgetId);
            };
            const setCell = (rowIndex: number, cellIndex: number, value: string) => {
                const rows: HTMLElement[] = Array.from(
                    fixture.nativeElement.querySelectorAll('[data-testid="row"]'),
                );
                const input = rows[rowIndex].querySelectorAll('input')[cellIndex] as HTMLInputElement;
                input.value = value;
                input.dispatchEvent(new Event('input'));
                resync(fixture, editor, widgetId);
            };

            addRow();
            addRow();

            // Both rows hold identical values so an index-vs-value track bug would be visible.
            setCell(0, 0, 'same');
            setCell(0, 1, 'NY');
            setCell(1, 0, 'same');
            setCell(1, 1, 'NY');

            setCell(1, 0, 'edited');

            let items = (
                editor.draft()!.widgets.find(w => w.id === widgetId)!.config as {
                    items: {label: string; state: string}[];
                }
            ).items;
            expect(items).toEqual([
                {label: 'same', state: 'NY'},
                {label: 'edited', state: 'NY'},
            ]);

            const removeButtons: HTMLButtonElement[] = Array.from(
                fixture.nativeElement.querySelectorAll('[data-testid="remove-row"]'),
            );
            removeButtons[0].click();
            resync(fixture, editor, widgetId);

            items = (
                editor.draft()!.widgets.find(w => w.id === widgetId)!.config as {
                    items: {label: string; state: string}[];
                }
            ).items;
            expect(items).toEqual([{label: 'edited', state: 'NY'}]);
        });

        it('associates the rows field label with the group instead of leaving a dangling for', () => {
            const {fixture} = setup('open-to');
            const label: HTMLLabelElement = fixture.nativeElement.querySelector('label');
            expect(label.getAttribute('for')).toBeNull();
            expect(label.id).toBeTruthy();

            const group: HTMLElement = fixture.nativeElement.querySelector('[role="group"]');
            expect(group.getAttribute('aria-labelledby')).toBe(label.id);
        });
    });

    it('associates every non-rows field label with its control via a for/id that resolves', () => {
        const {fixture} = setup('quote');
        const labels: HTMLLabelElement[] = Array.from(fixture.nativeElement.querySelectorAll('label[for]'));
        expect(labels.length).toBeGreaterThan(0);
        labels.forEach(label => {
            const targetId = label.getAttribute('for')!;
            expect(fixture.nativeElement.querySelector(`#${targetId}`)).toBeTruthy();
        });
    });

    describe('image upload', () => {
        function fireUpload(input: HTMLInputElement, file: File) {
            Object.defineProperty(input, 'files', {value: [file], configurable: true});
            input.dispatchEvent(new Event('change'));
        }

        it('upload failure surfaces the error string, not silence', () => {
            const {fixture} = setup('photo', {
                uploadImage: () => throwError(() => new Error('boom')),
                imageUrl: (id: string) => `https://images.test/${id}`,
            });
            const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type="file"]');
            fireUpload(input, new File(['x'], 'x.png', {type: 'image/png'}));
            fixture.detectChanges();

            expect(fixture.nativeElement.textContent).toContain('PROFILE.CANVAS.EDITOR.UPLOAD_FAILED');
        });

        it('holds the images cap when two uploads land out of order', () => {
            const subjectA = new Subject<{imageId: string; url: string}>();
            const subjectB = new Subject<{imageId: string; url: string}>();
            let call = 0;
            const {fixture, editor} = setup('gallery', {
                uploadImage: () => (call++ === 0 ? subjectA : subjectB).asObservable(),
                imageUrl: (id: string) => `https://images.test/${id}`,
            });
            const widgetId = editor.draft()!.widgets[0].id;
            const existing = Array.from({length: 7}, (_, i) => ({imageId: `existing-${i}`, alt: ''}));
            editor.patchConfig(widgetId, {items: existing});
            resync(fixture, editor, widgetId);

            const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type="file"]');
            // Both selections fire before either upload resolves: the component's own `widget`
            // input is never refreshed between them, standing in for the real race.
            fireUpload(input, new File(['a'], 'a.png', {type: 'image/png'}));
            fireUpload(input, new File(['b'], 'b.png', {type: 'image/png'}));

            subjectA.next({imageId: 'new-a', url: ''});
            subjectA.complete();
            subjectB.next({imageId: 'new-b', url: ''});
            subjectB.complete();

            const items = (
                editor.draft()!.widgets.find(w => w.id === widgetId)!.config as {items: {imageId: string}[]}
            ).items;
            // Length 8 alone cannot tell a held cap from the bug: the bug also lands at 8, by
            // dropping the first upload instead of correctly refusing the second.
            expect(items.map(i => i.imageId)).toEqual([...existing.map(i => i.imageId), 'new-a']);
        });
    });

    describe('timezone field', () => {
        const original = (Intl as {supportedValuesOf?: (key: string) => string[]}).supportedValuesOf;

        afterEach(() => {
            if (original) {
                (Intl as {supportedValuesOf?: (key: string) => string[]}).supportedValuesOf = original;
            } else {
                delete (Intl as {supportedValuesOf?: unknown}).supportedValuesOf;
            }
        });

        it('offers a filterable picker when the runtime can list zones', () => {
            const {fixture} = setup('local-time');
            expect(fixture.nativeElement.querySelector('p-select')).toBeTruthy();
            expect(fixture.nativeElement.querySelector('input[type="text"]')).toBeFalsy();
        });

        it('falls back to a plain input that still patches the config when the runtime cannot list zones', () => {
            (Intl as {supportedValuesOf?: unknown}).supportedValuesOf = undefined;
            const {fixture, editor} = setup('local-time');

            const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type="text"]');
            expect(input).toBeTruthy();
            expect(fixture.nativeElement.querySelector('p-select')).toBeFalsy();

            input.value = 'Europe/Zurich';
            input.dispatchEvent(new Event('input'));
            expect((editor.draft()!.widgets[0].config as {timeZone: string}).timeZone).toBe('Europe/Zurich');
        });
    });

    describe('config text history coalescing', () => {
        afterEach(() => vi.useRealTimers());

        it('typing several characters into a text field pushes one history entry for the whole burst', async () => {
            vi.useFakeTimers();
            const {fixture} = setup('quote');
            const history = TestBed.inject(ProfileEditHistoryService);
            history.reset(); // isolate the burst from the insert entry setup() left on the stack
            const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');

            for (const value of ['a', 'ab', 'abc']) {
                textarea.value = value;
                textarea.dispatchEvent(new Event('input'));
            }
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

            expect(history.canUndo()).toBe(true);
            const entry = history.undo();
            expect(history.canUndo()).toBe(false);
            const before = (entry as {before: CanvasWidgetDto[]}).before[0].config as {text: string};
            const after = (entry as {after: CanvasWidgetDto[]}).after[0].config as {text: string};
            expect(before.text).toBe('');
            expect(after.text).toBe('abc');
        });
    });

    describe('card toggle cap', () => {
        it('locks the toggle once two other widgets already show in the hover preview, but never locks it against turning itself off', () => {
            const {fixture, editor} = setup('quote');
            editor.insert('marquee');
            editor.insert('local-time');
            const widgets = editor.draft()!.widgets;

            editor.setCard(widgets[0].id, true);
            editor.setCard(widgets[1].id, true);

            resync(fixture, editor, widgets[2].id);
            let toggle: HTMLInputElement = fixture.nativeElement.querySelector('input[type="checkbox"]');
            expect(toggle.disabled).toBe(true);
            expect(fixture.nativeElement.textContent).toContain('PROFILE.CANVAS.EDITOR.CARD_FULL');

            resync(fixture, editor, widgets[0].id);
            toggle = fixture.nativeElement.querySelector('input[type="checkbox"]');
            expect(toggle.disabled).toBe(false);

            toggle.click();
            expect(editor.draft()!.widgets.find(w => w.id === widgets[0].id)!.card).toBe(false);
        });
    });

    describe('image removal', () => {
        it('deletes the image on the server and keeps the local removal even when the request fails', () => {
            const deleteImage = vi.fn(() => throwError(() => new Error('boom')));
            const {fixture, editor} = setup('gallery', {
                imageUrl: (id: string) => `https://images.test/${id}`,
                deleteImage,
            });
            const widgetId = editor.draft()!.widgets[0].id;
            editor.patchConfig(widgetId, {
                items: [
                    {imageId: 'img-1', alt: ''},
                    {imageId: 'img-2', alt: ''},
                ],
            });
            resync(fixture, editor, widgetId);
            const messageService = TestBed.inject(MessageService);
            const addSpy = vi.spyOn(messageService, 'add');

            const button: HTMLButtonElement = fixture.nativeElement.querySelector('.relative button');
            button.click();

            expect(deleteImage).toHaveBeenCalledWith('img-1');
            const items = (
                editor.draft()!.widgets.find(w => w.id === widgetId)!.config as {items: {imageId: string}[]}
            ).items;
            expect(items.map(i => i.imageId)).toEqual(['img-2']);
            expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({severity: 'error'}));
        });

        it('does not toast when the delete succeeds', () => {
            const deleteImage = vi.fn(() => of(undefined));
            const {fixture, editor} = setup('gallery', {
                imageUrl: (id: string) => `https://images.test/${id}`,
                deleteImage,
            });
            const widgetId = editor.draft()!.widgets[0].id;
            editor.patchConfig(widgetId, {items: [{imageId: 'img-1', alt: ''}]});
            resync(fixture, editor, widgetId);
            const messageService = TestBed.inject(MessageService);
            const addSpy = vi.spyOn(messageService, 'add');

            const button: HTMLButtonElement = fixture.nativeElement.querySelector('.relative button');
            button.click();

            expect(deleteImage).toHaveBeenCalledWith('img-1');
            expect(addSpy).not.toHaveBeenCalled();
        });

        it('does not push a history entry, so undo cannot bring back an image already deleted from the server', () => {
            const deleteImage = vi.fn(() => of(undefined));
            const {fixture, editor} = setup('gallery', {
                imageUrl: (id: string) => `https://images.test/${id}`,
                deleteImage,
            });
            const history = TestBed.inject(ProfileEditHistoryService);
            const widgetId = editor.draft()!.widgets[0].id;
            editor.patchConfig(widgetId, {items: [{imageId: 'img-1', alt: ''}]});
            resync(fixture, editor, widgetId);
            history.reset();

            const button: HTMLButtonElement = fixture.nativeElement.querySelector('.relative button');
            button.click();

            expect(history.canUndo()).toBe(false);
        });

        it('two removals fired before the input resyncs both read the live draft, not the stale input', () => {
            const deleteImage = vi.fn(() => of(undefined));
            const {fixture, editor} = setup('gallery', {
                imageUrl: (id: string) => `https://images.test/${id}`,
                deleteImage,
            });
            const widgetId = editor.draft()!.widgets[0].id;
            editor.patchConfig(widgetId, {
                items: [
                    {imageId: 'img-1', alt: ''},
                    {imageId: 'img-2', alt: ''},
                    {imageId: 'img-3', alt: ''},
                ],
            });
            resync(fixture, editor, widgetId);

            const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.relative button'));
            buttons[0].click(); // removes img-1 against the live draft
            buttons[1].click(); // still reading the pre-removal render: must still remove img-3, not re-add img-1

            const items = (
                editor.draft()!.widgets.find(w => w.id === widgetId)!.config as {items: {imageId: string}[]}
            ).items;
            expect(items.map(i => i.imageId)).toEqual(['img-2']);
            expect(deleteImage).toHaveBeenCalledWith('img-1');
            expect(deleteImage).toHaveBeenCalledWith('img-3');
            expect(deleteImage).not.toHaveBeenCalledWith('img-2');
        });
    });
});
