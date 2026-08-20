import {Editor} from '@tiptap/core';
import {wikiExtensions} from './wiki-extensions';
import {headingAnchorFor} from './wiki-block-handle.plugin';

/** Positions of every top-level block in document order. */
function blockPositions(editor: Editor): number[] {
    const positions: number[] = [];
    editor.state.doc.forEach((_node, offset) => positions.push(offset));
    return positions;
}

describe('headingAnchorFor', () => {
    let editor: Editor;

    beforeEach(() => {
        editor = new Editor({extensions: wikiExtensions('Write something…'), content: ''});
    });

    afterEach(() => editor.destroy());

    it('gives a heading its own anchor and a paragraph the heading above it', () => {
        editor.commands.setContent('# Setup\n\nfirst\n\n## Rollback\n\nsecond', {
            contentType: 'markdown',
        });
        const [setup, first, rollback, second] = blockPositions(editor);

        expect(headingAnchorFor(editor.state.doc, setup)).toBe('setup');
        expect(headingAnchorFor(editor.state.doc, first)).toBe('setup');
        expect(headingAnchorFor(editor.state.doc, rollback)).toBe('rollback');
        expect(headingAnchorFor(editor.state.doc, second)).toBe('rollback');
    });

    it('answers null for a block above every heading', () => {
        editor.commands.setContent('intro\n\n# Setup', {contentType: 'markdown'});
        const [intro] = blockPositions(editor);

        expect(headingAnchorFor(editor.state.doc, intro)).toBeNull();
    });

    it('uses the table of contents dedupe, so two headings called the same thing differ', () => {
        editor.commands.setContent('# Notes\n\na\n\n# Notes\n\nb', {contentType: 'markdown'});
        const positions = blockPositions(editor);

        expect(headingAnchorFor(editor.state.doc, positions[1])).toBe('notes');
        expect(headingAnchorFor(editor.state.doc, positions[3])).toBe('notes-2');
    });
});
