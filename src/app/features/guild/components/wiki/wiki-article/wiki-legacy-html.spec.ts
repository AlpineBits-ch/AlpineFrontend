import {Editor} from '@tiptap/core';
import {wikiExtensions} from './wiki-extensions';
import {isLegacyHtml} from './wiki-article.component';

/**
 * Which branch a stored body is loaded through.
 *
 * The first character used to decide it, which sent every page whose first block is a toggle
 * (`<details open>`) down the HTML branch and mangled the markdown after it.
 */
describe('isLegacyHtml', () => {
    it('says yes to a page saved as one run of tags before the markdown switch', () => {
        expect(isLegacyHtml('<h1>Runbook</h1><p>Call the on-call.</p><ul><li>one</li></ul>')).toBe(true);
    });

    it('says no to a page whose first block is a toggle', () => {
        expect(isLegacyHtml('<details open>\n<summary>Steps</summary>\n\nDo the thing\n\n</details>')).toBe(
            false,
        );
    });

    it('says no to a page whose first block is a sized image', () => {
        expect(isLegacyHtml('<img src="a.png" alt="a" width="640">\n\nAnd some prose.')).toBe(false);
    });

    it('says no to ordinary markdown', () => {
        expect(isLegacyHtml('# Heading\n\nProse.')).toBe(false);
        expect(isLegacyHtml('')).toBe(false);
    });
});

/** The round trip the branch above decides: both shapes have to survive being loaded and saved. */
describe('loading a stored page', () => {
    let editor: Editor;

    beforeEach(() => {
        editor = new Editor({extensions: wikiExtensions(''), content: ''});
    });

    afterEach(() => editor.destroy());

    function load(content: string): void {
        if (isLegacyHtml(content)) editor.commands.setContent(content);
        else editor.commands.setContent(content, {contentType: 'markdown'});
    }

    it('keeps a toggle-first page as markdown, headings after it included', () => {
        const stored = [
            '<details open>',
            '<summary>Prerequisites</summary>',
            '',
            'You need access.',
            '',
            '</details>',
            '',
            '## After the toggle',
            '',
            'Prose with **bold**.',
        ].join('\n');

        load(stored);
        const saved = editor.getMarkdown();

        expect(saved).toContain('<summary>Prerequisites</summary>');
        expect(saved).toContain('## After the toggle');
        expect(saved).toContain('**bold**');

        load(saved);
        expect(editor.getMarkdown()).toBe(saved);
    });

    it('still loads a legacy HTML page', () => {
        load('<h1>Runbook</h1><p>Call the on-call.</p>');

        expect(editor.state.doc.firstChild?.type.name).toBe('heading');
        expect(editor.getText()).toContain('Call the on-call.');
    });
});
