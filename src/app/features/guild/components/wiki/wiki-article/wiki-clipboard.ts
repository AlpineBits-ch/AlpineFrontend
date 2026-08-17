import {Extension} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';

/** What lands on the clipboard as plain text: still markdown, not flattened text, since the HTML flavour keeps formatting for editors that read it and the text flavour is what everything else (e.g. pasting into chat) gets; dropping the markers there would turn a bullet list into unrelated lines. */
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
                        // Falls back to the flat walk where the markdown manager is not registered, which is the case in any editor built without the Markdown extension.
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

/** One blank line between blocks, never more: a blank line is meaningful in markdown (it separates two paragraphs), so runs are collapsed rather than removed. Trailing spaces are also stripped, since two at a line's end are a hard break. */
export function tidyBlankLines(markdown: string): string {
    return markdown
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
