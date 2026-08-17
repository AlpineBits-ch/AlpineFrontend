import {JSONContent, mergeAttributes, Node} from '@tiptap/core';
import {DEFAULT_WIKI_BLOCK_LABELS, WikiBlockLabels} from './wiki-block-labels';

/** Collapsible sections, serialised as literal HTML (`<details open><summary>Title</summary>` blank line, body markdown, blank line, `</details>`) rather than a heading convention, since GFM passes raw HTML through everywhere the content is pasted. The blank lines around the body are load-bearing, or CommonMark treats the whole block as one HTML chunk; reading it back uses a custom block tokenizer, not marked's own HTML block rule, so those blank lines survive. */

const OPEN_REGEX = /^<details(\s+open)?\s*>[ \t]*\r?\n?/;
const TAG_REGEX = /<details\b[^>]*>|<\/details\s*>/g;
const TRAILING_REGEX = /^[ \t]*\r?\n?/;
const SUMMARY_REGEX = /^[ \t]*<summary>([\s\S]*?)<\/summary>[ \t]*\r?\n?/;

/** Finds the </details> that closes the one at the start of source, counting nested opens; a non-greedy [\s\S]*? would stop at the first close tag, which for a toggle inside a toggle is the inner one, and the outer would swallow half its own body. */
function matchDetails(source: string): {raw: string; open: boolean; inner: string} | null {
    const head = OPEN_REGEX.exec(source);
    if (!head) return null;

    TAG_REGEX.lastIndex = head[0].length;
    let depth = 1;
    let tag: RegExpExecArray | null;
    while ((tag = TAG_REGEX.exec(source)) !== null) {
        depth += tag[0].startsWith('</') ? -1 : 1;
        if (depth > 0) continue;
        const end = tag.index + tag[0].length;
        const trailing = TRAILING_REGEX.exec(source.slice(end))?.[0] ?? '';
        return {
            raw: source.slice(0, end + trailing.length),
            open: Boolean(head[1]),
            inner: source.slice(head[0].length, tag.index),
        };
    }
    return null;
}

export interface WikiToggleOptions {
    labels: WikiBlockLabels;
    HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        wikiToggle: {
            /** Inserts an open toggle with an empty summary and one empty paragraph. */
            setToggle: () => ReturnType;
        };
    }
}

export const WikiToggleSummary = Node.create({
    name: 'toggleSummary',

    content: 'inline*',

    defining: true,

    selectable: false,

    parseHTML() {
        return [{tag: 'summary'}];
    },

    renderHTML() {
        return ['summary', {class: 'wiki-toggle-summary'}, 0];
    },

    renderMarkdown: (node, helpers) => (node.content ? helpers.renderChildren(node.content, '') : ''),
});

export const WikiToggleBody = Node.create({
    name: 'toggleBody',

    content: 'block+',

    selectable: false,

    parseHTML() {
        return [{tag: 'div[data-toggle-body]'}];
    },

    renderHTML() {
        return ['div', {'data-toggle-body': '', class: 'wiki-toggle-body'}, 0];
    },

    renderMarkdown: (node, helpers) => (node.content ? helpers.renderChildren(node.content, '\n\n') : ''),
});

export const WikiToggle = Node.create<WikiToggleOptions>({
    name: 'toggle',

    group: 'block',

    content: 'toggleSummary toggleBody',

    defining: true,

    isolating: true,

    addOptions() {
        return {labels: DEFAULT_WIKI_BLOCK_LABELS, HTMLAttributes: {}};
    },

    addAttributes() {
        return {
            open: {
                default: true,
                parseHTML: element => element.hasAttribute('open'),
                renderHTML: attributes => (attributes['open'] ? {open: ''} : {}),
            },
        };
    },

    parseHTML() {
        return [{tag: 'details'}];
    },

    renderHTML({HTMLAttributes}) {
        return [
            'details',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {class: 'wiki-toggle'}),
            0,
        ];
    },

    /** Not a live <details> element, even though that is what it serialises to: a native one only hides children after its own first <summary>, and ProseMirror needs summary and body in one contentDOM, so open/closed is a data attribute and one CSS rule. Collapsing while reading must not write to the document, or folding a section while only viewing it would mark the page dirty. */
    addNodeView() {
        const labels = this.options.labels;
        return ({node, editor, getPos}) => {
            const dom = document.createElement('div');
            dom.className = 'wiki-toggle';

            const marker = document.createElement('span');
            marker.className = 'wiki-toggle-marker pi pi-chevron-right';
            marker.contentEditable = 'false';
            marker.title = labels.toggleExpand;
            marker.setAttribute('role', 'button');

            const content = document.createElement('div');
            content.className = 'wiki-toggle-content';

            dom.append(marker, content);

            let open = node.attrs['open'] !== false;
            const paint = () => dom.setAttribute('data-open', String(open));
            paint();

            marker.addEventListener('mousedown', event => event.preventDefault());
            marker.addEventListener('click', () => {
                open = !open;
                paint();
                const pos = getPos();
                if (!editor.isEditable || pos === undefined) return;
                editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'open', open));
            });

            return {
                dom,
                contentDOM: content,
                update: updated => {
                    if (updated.type.name !== 'toggle') return false;
                    open = updated.attrs['open'] !== false;
                    paint();
                    return true;
                },
                ignoreMutation: mutation => !content.contains(mutation.target as globalThis.Node),
            };
        };
    },

    markdownTokenName: 'wikiToggle',

    markdownTokenizer: {
        name: 'wikiToggle',
        level: 'block',
        start: source => source.indexOf('<details'),
        tokenize: (source, _tokens, lexer) => {
            const match = matchDetails(source);
            if (!match) return undefined;

            const summaryMatch = SUMMARY_REGEX.exec(match.inner);
            const summary = (summaryMatch?.[1] ?? '').trim();
            const body = (summaryMatch ? match.inner.slice(summaryMatch[0].length) : match.inner).trim();

            return {
                type: 'wikiToggle',
                raw: match.raw,
                open: match.open,
                summaryTokens: summary ? lexer.inlineTokens(summary) : [],
                tokens: body ? lexer.blockTokens(`${body}\n`) : [],
            };
        },
    },

    parseMarkdown: (token, helpers) => {
        const summary = Array.isArray(token['summaryTokens']) ? token['summaryTokens'] : [];
        const body = helpers.parseChildren(Array.isArray(token.tokens) ? token.tokens : []);
        return helpers.createNode('toggle', {open: token['open'] !== false}, [
            helpers.createNode('toggleSummary', undefined, helpers.parseInline(summary)),
            helpers.createNode(
                'toggleBody',
                undefined,
                body.length ? body : [helpers.createNode('paragraph')],
            ),
        ]);
    },

    renderMarkdown: (node, helpers) => {
        const children = node.content ?? [];
        const summaryNode = children.find((child: JSONContent) => child.type === 'toggleSummary');
        const bodyNode = children.find((child: JSONContent) => child.type === 'toggleBody');
        const summary = (summaryNode ? helpers.renderChildren([summaryNode], '') : '').trim();
        const body = (bodyNode ? helpers.renderChildren([bodyNode], '') : '').trim();
        const open = node.attrs?.['open'] === false ? '' : ' open';
        const head = `<details${open}>\n<summary>${summary}</summary>`;
        // The blank lines around the body keep it parsing as markdown rather than one opaque HTML chunk; an empty body would otherwise leave four of them in a row.
        return body ? `${head}\n\n${body}\n\n</details>` : `${head}\n\n</details>`;
    },

    addCommands() {
        return {
            setToggle:
                () =>
                ({commands}) =>
                    commands.insertContent({
                        type: this.name,
                        attrs: {open: true},
                        content: [
                            {type: 'toggleSummary'},
                            {type: 'toggleBody', content: [{type: 'paragraph'}]},
                        ],
                    }),
        };
    },

    addKeyboardShortcuts() {
        return {
            // Enter at the end of the summary should drop into the body, not split the summary into a second one; the schema only allows exactly one.
            Enter: () => {
                const {state} = this.editor;
                const {$from, empty} = state.selection;
                if (!empty || $from.parent.type.name !== 'toggleSummary') return false;
                const bodyStart = $from.after($from.depth) + 1;
                return this.editor.commands.setTextSelection(bodyStart + 1);
            },
        };
    },
});
