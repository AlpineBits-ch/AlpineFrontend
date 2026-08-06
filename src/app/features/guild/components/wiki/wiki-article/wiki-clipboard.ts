import {Extension} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';

/**
 * What lands on the clipboard as plain text when you copy out of a page.
 *
 * The default serialisation stacked separators - the document's own block separator on top of the
 * markdown serializer's trailing newlines - so every paragraph arrived three blank lines from the
 * last one. Pasting a page into a message turned it into a column of whitespace.
 *
 * Still markdown rather than flattened text: the HTML flavour keeps formatting for editors that
 * read it, and the text flavour is what everything else gets. Dropping the markers there would mean
 * a bullet list pasted into chat arrives as unrelated lines.
 */
export const WikiClipboardMarkdown = Extension.create({
    name: 'wikiClipboardMarkdown',

    addProseMirrorPlugins() {
        const editor = this.editor;
        return [
            new Plugin({
                key: new PluginKey('wikiClipboardMarkdown'),
                props: {
                    clipboardTextSerializer: slice => {
                        const manager = editor.storage['markdown']?.manager;
                        const content = slice.content.toJSON() ?? [];
                        // Falls back to the flat walk where the markdown manager is not registered,
                        // which is the case in any editor built without the Markdown extension.
                        const text = manager
                            ? (manager as {serialize: (json: unknown) => string})
                                .serialize({type: 'doc', content})
                            : slice.content.textBetween(0, slice.content.size, '\n\n');
                        return tidyBlankLines(text);
                    },
                },
            }),
        ];
    },
});

/**
 * One blank line between blocks, never more.
 *
 * A blank line is meaningful in markdown - it is what separates two paragraphs - so they are
 * collapsed to one rather than removed. Trailing spaces go too: two of them at the end of a line
 * are a hard break, and picking those up by accident is its own surprise on the other end.
 */
export function tidyBlankLines(markdown: string): string {
    return markdown
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
