import {describe, expect, it} from 'vitest';
import {detectTrigger} from './composer-utils';

function makeEditorWithCursorAt(text: string, cursorOffset: number): HTMLElement {
    const editor = document.createElement('div');
    const textNode = document.createTextNode(text);
    editor.appendChild(textNode);
    document.body.appendChild(editor);
    const range = document.createRange();
    range.setStart(textNode, cursorOffset);
    range.setEnd(textNode, cursorOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return editor;
}

describe('detectTrigger mention detection', () => {
    it('detects a bare @ at the start of input', () => {
        const editor = makeEditorWithCursorAt('@', 1);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('');
    });

    it('detects @everyone as an in-progress mention query', () => {
        const editor = makeEditorWithCursorAt('@everyone', 9);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('everyone');
    });

    it('detects @here as an in-progress mention query', () => {
        const editor = makeEditorWithCursorAt('hey @here', 9);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('here');
    });

    it('detects a role-name query the same way as a user query (both are plain @word)', () => {
        const editor = makeEditorWithCursorAt('@mod', 4);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('mod');
    });
});
