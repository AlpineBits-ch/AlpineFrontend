import {describe, expect, it} from 'vitest';
import {
    blockOf,
    blocksOf,
    buildHighlightedFragment,
    EditorSegment,
    getEditorSegments,
    getTextCursorOffset,
    highlightBlock,
    highlightInlineMarkdown,
    needsReblock,
    renderBlocks,
    restoreCursorOffset,
    splitIntoBlocks,
} from './composer-markdown';

function segmentsToText(segments: EditorSegment[]): string {
    return segments.map(s => (s.type === 'text' ? s.text : '')).join('');
}

function editorWith(html: string): HTMLElement {
    const editor = document.createElement('div');
    editor.innerHTML = html;
    document.body.appendChild(editor);
    return editor;
}

function chip(display: string): string {
    return `<span class="mention-chip" data-display="${display}">${display}</span>`;
}

/** Round-trip: highlight the editor the way the composer does, in one pass. */
function rehighlight(editor: HTMLElement): void {
    const frag = buildHighlightedFragment(getEditorSegments(editor));
    editor.innerHTML = '';
    editor.appendChild(frag);
}

describe('highlightInlineMarkdown', () => {
    it('escapes HTML before doing anything else', () => {
        expect(highlightInlineMarkdown('<script>alert(1)</script>')).toBe(
            '&lt;script&gt;alert(1)&lt;/script&gt;',
        );
    });

    it('wraps bold in marks on both sides', () => {
        expect(highlightInlineMarkdown('**hi**')).toBe(
            '<span class="md-mark">**</span><strong>hi</strong><span class="md-mark">**</span>',
        );
    });

    it('keeps an unterminated bold open with a single leading mark', () => {
        expect(highlightInlineMarkdown('**hi')).toBe('<span class="md-mark">**</span><strong>hi</strong>');
    });

    it('turns newlines into br', () => {
        expect(highlightInlineMarkdown('a\nb')).toBe('a<br>b');
    });

    it('leaves the contents of a fenced block unstyled', () => {
        const html = highlightInlineMarkdown('```\n**not bold**\n```');
        expect(html).toContain('**not bold**');
        expect(html).not.toContain('<strong>');
    });

    it('highlights a fenced block with a known language', () => {
        const html = highlightInlineMarkdown('```js\nconst a = 1;\n```');
        expect(html).toContain('md-lang');
        expect(html).toContain('hljs-keyword');
    });

    it('keeps an unterminated fence rendering as a code block', () => {
        const html = highlightInlineMarkdown('```\nstill typing');
        expect(html).toContain('still typing');
        expect(html).not.toContain('<strong>');
    });

    it('does not style across a newline', () => {
        expect(highlightInlineMarkdown('*a\nb*')).toBe('*a<br>b*');
    });
});

describe('getEditorSegments', () => {
    it('flattens markdown wrappers back to raw source text', () => {
        const editor = editorWith(
            '<span class="md-mark">**</span><strong>hi</strong><span class="md-mark">**</span>',
        );
        expect(getEditorSegments(editor)).toEqual([{type: 'text', text: '**hi**'}]);
    });

    it('splits text around a mention chip', () => {
        const editor = editorWith(`a${chip('@Ann')}b`);
        const segs = getEditorSegments(editor);
        expect(segs.map(s => s.type)).toEqual(['text', 'chip', 'text']);
    });

    it('reads a br as a newline', () => {
        const editor = editorWith('a<br>b');
        expect(getEditorSegments(editor)).toEqual([{type: 'text', text: 'a\nb'}]);
    });

    it('ignores the trailing sentinel br', () => {
        const editor = editorWith('a<br><br data-sentinel="1">');
        expect(getEditorSegments(editor)).toEqual([{type: 'text', text: 'a\n'}]);
    });

    it('survives a re-highlight round trip unchanged', () => {
        const editor = editorWith('');
        editor.textContent = '**bold** and *italic* and `code`';
        const before = getEditorSegments(editor);
        rehighlight(editor);
        expect(getEditorSegments(editor)).toEqual(before);
    });

    it('keeps a chip through a re-highlight round trip', () => {
        const editor = editorWith(`hi ${chip('@Ann')} **there**`);
        rehighlight(editor);
        const segs = getEditorSegments(editor);
        expect(segs.map(s => s.type)).toEqual(['text', 'chip', 'text']);
        expect(editor.querySelectorAll('.mention-chip')).toHaveLength(1);
    });
});

describe('cursor offset round trip', () => {
    function offsetAfterRestore(html: string, target: number): number {
        const editor = editorWith(html);
        restoreCursorOffset(editor, target);
        return getTextCursorOffset(editor);
    }

    it('round-trips inside a plain text run', () => {
        expect(offsetAfterRestore('hello world', 5)).toBe(5);
    });

    it('round-trips across a br', () => {
        expect(offsetAfterRestore('ab<br>cd', 4)).toBe(4);
    });

    it('counts a chip as its display length', () => {
        expect(offsetAfterRestore(`x${chip('@Ann')}y`, 5)).toBe(5);
    });

    it('counts an emoji image as one character', () => {
        expect(offsetAfterRestore('a<img data-emoji="\u{1F600}">b', 2)).toBe(2);
    });

    it('clamps past the end to the end', () => {
        const editor = editorWith('abc');
        restoreCursorOffset(editor, 999);
        expect(getTextCursorOffset(editor)).toBe(3);
    });

    it('round-trips through a highlight rebuild', () => {
        const editor = editorWith('');
        editor.textContent = 'say **something** here';
        restoreCursorOffset(editor, 8);
        const before = getTextCursorOffset(editor);
        rehighlight(editor);
        restoreCursorOffset(editor, before);
        expect(getTextCursorOffset(editor)).toBe(before);
    });
});

describe('splitIntoBlocks', () => {
    it('keeps a single paragraph whole', () => {
        expect(splitIntoBlocks('one line')).toEqual(['one line']);
    });

    it('splits on a blank line and keeps the separator with the block before it', () => {
        expect(splitIntoBlocks('a\n\nb')).toEqual(['a\n\n', 'b']);
    });

    it('treats a run of blank lines as one boundary', () => {
        expect(splitIntoBlocks('a\n\n\n\nb')).toEqual(['a\n\n\n\n', 'b']);
    });

    it('does not split a single newline', () => {
        expect(splitIntoBlocks('a\nb')).toEqual(['a\nb']);
    });

    it('never splits inside a fence', () => {
        expect(splitIntoBlocks('```\na\n\nb\n```')).toEqual(['```\na\n\nb\n```']);
    });

    it('never splits inside an unterminated fence', () => {
        expect(splitIntoBlocks('```\na\n\nb')).toEqual(['```\na\n\nb']);
    });

    it('splits around a closed fence', () => {
        expect(splitIntoBlocks('intro\n\n```\nx\n\ny\n```\n\nend')).toEqual([
            'intro\n\n',
            '```\nx\n\ny\n```\n\n',
            'end',
        ]);
    });

    it('always reproduces the input when joined', () => {
        for (const text of ['', 'a', 'a\n\nb\n\n\nc', '```\na\n\nb\n```\n\ntail', '\n\n\n']) {
            expect(splitIntoBlocks(text).join('')).toBe(text);
        }
    });
});

describe('renderBlocks', () => {
    it('produces one block span per paragraph', () => {
        const editor = editorWith('');
        editor.textContent = 'one\n\ntwo\n\nthree';
        renderBlocks(editor, getEditorSegments(editor));
        expect(blocksOf(editor)).toHaveLength(3);
    });

    it('round-trips the source text unchanged', () => {
        const editor = editorWith('');
        editor.textContent = 'one\n\n**two**\n\nthree';
        renderBlocks(editor, getEditorSegments(editor));
        expect(segmentsToText(getEditorSegments(editor))).toBe('one\n\n**two**\n\nthree');
    });

    it('keeps a chip in the block it was typed into', () => {
        const editor = editorWith(`first\n\nsecond ${chip('@Ann')}`);
        renderBlocks(editor, getEditorSegments(editor));
        const blocks = blocksOf(editor);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].querySelector('.mention-chip')).toBeNull();
        expect(blocks[1].querySelector('.mention-chip')).not.toBeNull();
    });

    it('highlights each block independently', () => {
        const editor = editorWith('');
        editor.textContent = '**a**\n\n**b**';
        renderBlocks(editor, getEditorSegments(editor));
        for (const block of blocksOf(editor)) {
            expect(block.querySelector('strong')).not.toBeNull();
        }
    });

    it('re-highlighting one block leaves the others untouched', () => {
        const editor = editorWith('');
        editor.textContent = 'first\n\nsecond';
        renderBlocks(editor, getEditorSegments(editor));
        const [first, second] = blocksOf(editor);
        const untouched = second.firstChild;

        highlightBlock(first, [{type: 'text', text: 'first edited\n\n'}]);

        expect(blocksOf(editor)[1].firstChild).toBe(untouched);
        expect(segmentsToText(getEditorSegments(editor))).toBe('first edited\n\nsecond');
    });

    it('finds the block a node sits in', () => {
        const editor = editorWith('');
        editor.textContent = 'one\n\ntwo';
        renderBlocks(editor, getEditorSegments(editor));
        const blocks = blocksOf(editor);
        expect(blockOf(blocks[1].firstChild, editor)).toBe(blocks[1]);
    });

    it('asks for a reblock while the editor is still raw', () => {
        const editor = editorWith('');
        editor.textContent = 'typed straight in';
        expect(needsReblock(editor)).toBe(true);
        renderBlocks(editor, getEditorSegments(editor));
        expect(needsReblock(editor)).toBe(false);
    });

    it('treats an empty editor as already blocked', () => {
        expect(needsReblock(editorWith(''))).toBe(false);
    });
});
