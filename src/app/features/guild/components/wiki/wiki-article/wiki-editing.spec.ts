import {Editor} from '@tiptap/core';
import {wikiExtensions} from './wiki-extensions';

/** The same run the Tab handler inserts: non-breaking, because a literal tab at the start of a line reparses out of markdown as an indented code block. */
const INDENT = ' '.repeat(4);

/** The editing behaviours that are only true if the whole extension list agrees: each came from two extensions assuming the other bound the key, so a unit test on either in isolation would have passed; these build the real list. */
describe('wiki editor keys', () => {
    let editor: Editor;

    beforeEach(() => {
        editor = new Editor({extensions: wikiExtensions('Write something…'), content: ''});
    });

    afterEach(() => editor.destroy());

    /** Routes through ProseMirror's own keydown handling, keymaps and all. */
    function press(key: string, shift = false): void {
        editor.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', {key, shiftKey: shift, bubbles: true, cancelable: true}),
        );
    }

    /** Types text the way a person does, so input rules see it. */
    function type(text: string): void {
        const {from, to} = editor.state.selection;
        const handled = editor.view.someProp('handleTextInput', fn =>
            fn(editor.view, from, to, text, () => editor.state.tr.insertText(text, from, to)),
        );
        if (!handled) editor.view.dispatch(editor.state.tr.insertText(text, from, to));
    }

    function nodeNames(): string[] {
        const names: string[] = [];
        editor.state.doc.descendants(node => {
            names.push(node.type.name);
            return true;
        });
        return names;
    }

    describe('Tab', () => {
        it('indents a checklist item instead of moving focus', () => {
            editor.commands.setContent('- [ ] first\n- [ ] second', {contentType: 'markdown'});
            // Into the second item, which is the only one that can be sunk under a sibling.
            editor.commands.setTextSelection(editor.state.doc.content.size - 2);

            press('Tab');

            // A nested list only exists if the sink actually ran.
            expect(nodeNames().filter(name => name === 'taskList').length).toBe(2);
        });

        it('indents a bullet item', () => {
            editor.commands.setContent('- first\n- second', {contentType: 'markdown'});
            editor.commands.setTextSelection(editor.state.doc.content.size - 2);

            press('Tab');

            expect(nodeNames().filter(name => name === 'bulletList').length).toBe(2);
        });

        it('indents at the caret in prose, the way a text editor does', () => {
            editor.commands.setContent('one two', {contentType: 'markdown'});
            editor.commands.setTextSelection(4);

            press('Tab');

            // Position 4 is the end of "one", so the step lands there and the space follows it.
            expect(editor.state.selection.$from.parent.textContent).toBe(`one${INDENT} two`);
            // The caret stays after what it inserted rather than moving anywhere else.
            expect(editor.state.selection.from).toBe(4 + INDENT.length);
        });

        it('indents at the start of a line without turning the paragraph into code', () => {
            editor.commands.setContent('indented para', {contentType: 'markdown'});
            editor.commands.setTextSelection(1);

            press('Tab');
            // Saved and loaded again, which is what a mode switch and a page reload both do.
            const saved = editor.getMarkdown();
            editor.commands.setContent(saved, {contentType: 'markdown'});

            // A literal tab here reparses as an indented code block, and the paragraph is gone.
            expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
            expect(editor.state.doc.firstChild?.textContent).toBe(`${INDENT}indented para`);
            expect(editor.getMarkdown()).toBe(saved);
        });

        it('takes the indent back off with Shift-Tab', () => {
            editor.commands.setContent('one two', {contentType: 'markdown'});
            editor.commands.setTextSelection(4);
            press('Tab');

            press('Tab', true);

            expect(editor.state.selection.$from.parent.textContent).toBe('one two');
        });

        it('leaves the text alone when Shift-Tab has no indent to remove', () => {
            editor.commands.setContent('one two', {contentType: 'markdown'});
            editor.commands.setTextSelection(4);
            const before = editor.getHTML();

            press('Tab', true);

            expect(editor.getHTML()).toBe(before);
        });

        it('moves between table cells rather than indenting inside one', () => {
            editor.commands.setContent('| Field | Value |\n| --- | --- |\n| Date |  |', {
                contentType: 'markdown',
            });
            // First header cell.
            editor.commands.setTextSelection(4);
            const start = editor.state.selection.$from.parent.textContent;

            press('Tab');

            expect(editor.state.selection.$from.parent.textContent).not.toBe(start);
            expect(editor.getText()).not.toContain(INDENT);
        });
    });

    describe('Enter in a list', () => {
        /** Enter twice from the end of the document, then: where did the caret end up? */
        function breaksOut(): boolean {
            editor.commands.setTextSelection(editor.state.doc.content.size);
            press('Enter'); // opens an empty next item
            press('Enter'); // and should leave the list

            const doc = editor.state.doc;
            const last = doc.lastChild;
            if (last?.type.name !== 'paragraph') return false;
            // The caret has to be in that new paragraph, not back up in the item above.
            return editor.state.selection.from > doc.content.size - last.nodeSize;
        }

        it('breaks out of a bullet list rather than back into the item above', () => {
            editor.commands.setContent('- only item', {contentType: 'markdown'});
            expect(breaksOut()).toBe(true);
        });

        it('breaks out of a numbered list', () => {
            editor.commands.setContent('1. only item', {contentType: 'markdown'});
            expect(breaksOut()).toBe(true);
        });

        it('breaks out of a checklist', () => {
            editor.commands.setContent('- [ ] only item', {contentType: 'markdown'});
            expect(breaksOut()).toBe(true);
        });

        it('breaks out of a list that has content after it', () => {
            editor.commands.setContent('- only item\n\n## After', {contentType: 'markdown'});
            // End of "only item", which is inside the list rather than at the end of the document.
            const listEnd = editor.state.doc.firstChild!.nodeSize - 2;
            editor.commands.setTextSelection(listEnd);

            press('Enter');
            press('Enter');

            // A paragraph between the list and the heading, with the caret in it, not back up in "only item" and not merged into the heading below.
            const kinds: string[] = [];
            editor.state.doc.forEach(node => kinds.push(node.type.name));
            // Sliced because the trailing-node extension keeps its own empty paragraph at the end of the document, which is not what this test is about.
            expect(kinds.slice(0, 3)).toEqual(['bulletList', 'paragraph', 'heading']);
            expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
        });

        it('breaks out of an indented bullet to the level above', () => {
            editor.commands.setContent('- outer\n    - inner', {contentType: 'markdown'});
            editor.commands.setTextSelection(editor.state.doc.content.size);

            press('Enter');
            press('Enter');

            // Out of the nested list, but still in the outer one: two Enters is one level, not an exit from the whole structure.
            expect(nodeNames()).toContain('bulletList');
            expect(editor.state.selection.$from.node(-1)?.type.name).toBe('listItem');
        });
    });

    describe('checkbox from a bullet', () => {
        it('turns "- [ ] " into a task item', () => {
            // The state the user is actually in: they typed "- ", the input rule already fired, and they are standing in an empty bullet item about to type the brackets.
            editor.commands.toggleBulletList();
            expect(nodeNames()).toContain('bulletList');

            type('[');
            type(' ');
            type(']');
            type(' ');

            expect(nodeNames()).toContain('taskItem');
        });

        it('leaves "[ ] " alone in the middle of a line', () => {
            editor.commands.setContent('- pick one', {contentType: 'markdown'});
            editor.commands.setTextSelection(editor.state.doc.content.size);

            type('[');
            type(' ');
            type(']');
            type(' ');

            expect(nodeNames()).not.toContain('taskItem');
        });
    });
});

/** Copying a page out of the wiki: paragraphs must be separated by exactly one blank line, not stacked into a column of whitespace. */
describe('wiki clipboard text', () => {
    let editor: Editor;

    beforeEach(() => {
        editor = new Editor({extensions: wikiExtensions('')});
    });

    afterEach(() => editor.destroy());

    function copyAll(): string {
        editor.commands.selectAll();
        const {from, to} = editor.state.selection;
        const slice = editor.state.doc.slice(from, to);
        return editor.view.someProp('clipboardTextSerializer', fn => fn(slice, editor.view)) ?? '';
    }

    it('separates blocks by exactly one blank line', () => {
        editor.commands.setContent(
            'First paragraph.\n\nSecond paragraph.\n\n## A heading\n\nThird paragraph.',
            {contentType: 'markdown'},
        );

        const copied = copyAll();

        expect(copied).not.toMatch(/\n{3,}/);
        expect(copied).toContain('First paragraph.');
        expect(copied).toContain('Third paragraph.');
    });

    it('keeps list markers, so a pasted list is still a list', () => {
        editor.commands.setContent('- one\n- two\n- three', {contentType: 'markdown'});

        const copied = copyAll();

        expect(copied).not.toMatch(/\n{3,}/);
        expect(copied.split('\n').filter(line => line.startsWith('- ')).length).toBe(3);
    });
});

/** Switching between the rich surface and the markdown one is serialise-then-reparse, so anything that does not survive the round trip is silently deleted from somebody's page; this is the whole check behind "switching modes must never lose data". */
describe('wiki markdown round trip', () => {
    const FIXTURE = [
        '# Heading one',
        '',
        'Prose with **bold**, *italic*, `code` and a [link](https://example.com).',
        '',
        '> [!NOTE]',
        '> A callout that has to keep its variant.',
        '',
        '- bullet one',
        '- bullet two',
        '',
        '1. numbered one',
        '2. numbered two',
        '',
        '- [ ] unchecked task',
        '- [x] checked task',
        '',
        '| Field | Value |',
        '| --- | --- |',
        '| Date | today |',
        '',
        '```bash',
        'echo "the exact command"',
        '```',
        '',
        '---',
        '',
        'A [page link](wiki:page-123) and a [@Someone](user:user-456).',
        '',
    ].join('\n');

    it('is stable across serialise, reparse, serialise', () => {
        const editor = new Editor({extensions: wikiExtensions('')});
        try {
            editor.commands.setContent(FIXTURE, {contentType: 'markdown'});
            const once = editor.getMarkdown();

            editor.commands.setContent(once, {contentType: 'markdown'});
            const twice = editor.getMarkdown();

            expect(twice).toBe(once);
        } finally {
            editor.destroy();
        }
    });

    it('keeps every block kind through the round trip', () => {
        const editor = new Editor({extensions: wikiExtensions('')});
        try {
            editor.commands.setContent(FIXTURE, {contentType: 'markdown'});
            editor.commands.setContent(editor.getMarkdown(), {contentType: 'markdown'});

            const markdown = editor.getMarkdown();
            for (const fragment of [
                '# Heading one',
                '**bold**',
                '[!NOTE]',
                '- bullet one',
                '1. numbered one',
                '- [ ] unchecked task',
                '- [x] checked task',
                '| Field | Value |',
                'echo "the exact command"',
                '](wiki:page-123)',
                '](user:user-456)',
            ]) {
                expect(markdown).toContain(fragment);
            }
        } finally {
            editor.destroy();
        }
    });
});
