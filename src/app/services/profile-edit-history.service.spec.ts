import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {PROFILE_HISTORY_DEPTH, ProfileEditHistoryService} from './profile-edit-history.service';
import {CanvasWidgetDto} from '../dtos/response/profile-canvas.dto';
import {ProfileFont} from '../dtos/response/profile.dto';

function service(): ProfileEditHistoryService {
    TestBed.configureTestingModule({});
    return TestBed.inject(ProfileEditHistoryService);
}

function widgets(id: string): CanvasWidgetDto[] {
    return [{id, type: 'quote', x: 0, y: 0, w: 2, h: 1, visibility: 'everyone', card: false, config: {}}];
}

describe('ProfileEditHistoryService', () => {
    it('starts with nothing to undo or redo', () => {
        const history = service();
        expect(history.canUndo()).toBe(false);
        expect(history.canRedo()).toBe(false);
    });

    describe('text coalescing', () => {
        it('one commit produces one entry regardless of how many keystrokes noted it', () => {
            const history = service();
            history.noteTextField('bio', '');
            history.noteTextField('bio', ''); // a later keystroke in the same pause: the burst's start still wins
            history.commitText({bio: 'abc', accentColor: '', font: ProfileFont.Default});

            expect(history.canUndo()).toBe(true);
            const entry = history.undo();
            expect(entry).toMatchObject({domain: 'text', kind: 'bio', before: '', after: 'abc'});
            expect(history.canUndo()).toBe(false);
        });

        it('does not push an entry when the pause ends with the field unchanged', () => {
            const history = service();
            history.noteTextField('bio', 'same');
            history.commitText({bio: 'same', accentColor: '', font: ProfileFont.Default});

            expect(history.canUndo()).toBe(false);
        });

        it('commits one entry per field that actually changed in the pause', () => {
            const history = service();
            history.noteTextField('bio', 'old bio');
            history.noteTextField('font', ProfileFont.Default);
            history.commitText({bio: 'new bio', accentColor: '', font: ProfileFont.Serif});

            const second = history.undo();
            const first = history.undo();
            expect([first, second]).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({kind: 'bio', before: 'old bio', after: 'new bio'}),
                    expect.objectContaining({kind: 'font', before: ProfileFont.Default, after: ProfileFont.Serif}),
                ]),
            );
            expect(history.canUndo()).toBe(false);
        });
    });

    describe('undo and redo', () => {
        it('undo moves the top entry to the redo stack', () => {
            const history = service();
            history.pushCanvas('add', 'quote', [], widgets('w1'));

            const entry = history.undo();
            expect(entry).toMatchObject({domain: 'canvas', kind: 'add', widgetType: 'quote'});
            expect(history.canUndo()).toBe(false);
            expect(history.canRedo()).toBe(true);
        });

        it('redo replays what undo just reversed', () => {
            const history = service();
            history.pushCanvas('add', 'quote', [], widgets('w1'));
            history.undo();

            const entry = history.redo();
            expect(entry).toMatchObject({domain: 'canvas', kind: 'add', widgetType: 'quote'});
            expect(history.canRedo()).toBe(false);
            expect(history.canUndo()).toBe(true);
        });

        it('a fresh push clears whatever was redoable', () => {
            const history = service();
            history.pushCanvas('add', 'quote', [], widgets('w1'));
            history.undo();
            expect(history.canRedo()).toBe(true);

            history.pushCanvas('remove', 'photo', widgets('w2'), []);
            expect(history.canRedo()).toBe(false);
        });

        it('undoing with nothing pending returns null and does not touch the redo stack', () => {
            const history = service();
            expect(history.undo()).toBeNull();
            expect(history.canRedo()).toBe(false);
        });
    });

    it('caps the undo stack at the depth bound, dropping the oldest', () => {
        const history = service();
        for (let i = 0; i < PROFILE_HISTORY_DEPTH + 10; i++) {
            history.pushCanvas('add', 'quote', [], widgets(`w${i}`));
        }

        const popped: string[] = [];
        let entry = history.undo();
        while (entry) {
            if (entry.domain === 'canvas') popped.push(entry.after[0].id);
            entry = history.undo();
        }

        expect(popped).toHaveLength(PROFILE_HISTORY_DEPTH);
        // The oldest 10 pushes were dropped; the most recently undone entry is the very last push.
        expect(popped[0]).toBe(`w${PROFILE_HISTORY_DEPTH + 9}`);
    });

    it('reset drops both stacks and any pending text pause', () => {
        const history = service();
        history.pushCanvas('add', 'quote', [], widgets('w1'));
        history.undo();
        history.noteTextField('bio', 'old');

        history.reset();

        expect(history.canUndo()).toBe(false);
        expect(history.canRedo()).toBe(false);
        history.commitText({bio: 'new', accentColor: '', font: ProfileFont.Default});
        expect(history.canUndo()).toBe(false); // the pending note was dropped by reset, not carried into the commit
    });
});
