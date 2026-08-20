import {Extension} from '@tiptap/core';
import {EditorState, Plugin, PluginKey, TextSelection, Transaction} from '@tiptap/pm/state';
import {Decoration, DecorationSet, EditorView} from '@tiptap/pm/view';
import {Node as ProseMirrorNode} from '@tiptap/pm/model';
import {FindBlock, findMatchesInBlocks, matchNearest, TextRange} from './wiki-find';

/**
 * Ctrl+F for the article surface.
 *
 * Highlighting is a decoration over plugin state, so it works in read mode: nothing here writes
 * to the document unless replace is asked for, and replace is refused on a view that is not
 * editable. The commands below take an {@link EditorView} rather than being TipTap commands so
 * the bar can drive them without an editable editor.
 */

export interface WikiFindQuery {
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
}

export interface WikiFindState extends WikiFindQuery {
    open: boolean;
    matches: readonly TextRange[];
    /** Index into `matches`, or -1 when there is nothing to be on. */
    current: number;
}

type FindMeta =
    | {kind: 'open'; query?: string}
    | {kind: 'close'}
    | {kind: 'query'; patch: Partial<WikiFindQuery>}
    | {kind: 'current'; index: number};

export const wikiFindKey = new PluginKey<WikiFindState>('wikiFind');

const EMPTY: WikiFindState = {
    open: false,
    query: '',
    caseSensitive: false,
    wholeWord: false,
    matches: [],
    current: -1,
};

/** A one-space stand-in per inline leaf, whose nodeSize is 1, so string offsets stay document offsets. */
const LEAF_TEXT = ' ';

function blocksOf(doc: ProseMirrorNode): FindBlock[] {
    const blocks: FindBlock[] = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        blocks.push({text: node.textBetween(0, node.content.size, undefined, LEAF_TEXT), base: pos + 1});
        return false;
    });
    return blocks;
}

function recompute(state: WikiFindState, doc: ProseMirrorNode, caret: number): WikiFindState {
    if (!state.open || !state.query) return {...state, matches: [], current: -1};
    const matches = findMatchesInBlocks(blocksOf(doc), state.query, state);
    return {...state, matches, current: matchNearest(matches, caret)};
}

export function wikiFindPlugin(): Plugin<WikiFindState> {
    return new Plugin<WikiFindState>({
        key: wikiFindKey,

        state: {
            init: () => EMPTY,
            apply: (tr, value, _oldState, newState) => {
                const meta = tr.getMeta(wikiFindKey) as FindMeta | undefined;

                if (meta?.kind === 'close') return EMPTY;
                if (meta?.kind === 'current') return {...value, current: meta.index};
                if (meta?.kind === 'open') {
                    const next = {...value, open: true, query: meta.query ?? value.query};
                    return recompute(next, newState.doc, newState.selection.from);
                }
                if (meta?.kind === 'query') {
                    return recompute({...value, ...meta.patch}, newState.doc, newState.selection.from);
                }
                if (tr.docChanged && value.open) {
                    // The caret the search re-centres on is the old current match, moved by this
                    // change; without mapping it, every edit throws the user back to match one.
                    const anchor = value.matches[value.current]?.from;
                    const caret = anchor === undefined ? newState.selection.from : tr.mapping.map(anchor);
                    return recompute(value, newState.doc, caret);
                }
                return value;
            },
        },

        props: {
            decorations: state => {
                const find = wikiFindKey.getState(state);
                if (!find?.open || !find.matches.length) return null;
                return DecorationSet.create(
                    state.doc,
                    find.matches.map((match, index) =>
                        Decoration.inline(match.from, match.to, {
                            class: index === find.current ? 'wiki-find-current' : 'wiki-find-match',
                            // Inline, not from a stylesheet: this plugin has to be droppable into
                            // the editor without a matching CSS change landing in a file it does
                            // not own.
                            style:
                                index === find.current
                                    ? 'background: var(--color-brand); color: #fff; border-radius: 2px;'
                                    : 'background: color-mix(in srgb, var(--color-brand) 30%, transparent); border-radius: 2px;',
                        }),
                    ),
                );
            },
        },
    });
}

/** Registers the plugin in an extension list. */
export const WikiFind = Extension.create({
    name: 'wikiFind',
    addProseMirrorPlugins: () => [wikiFindPlugin()],
});

export function wikiFindState(state: EditorState): WikiFindState {
    return wikiFindKey.getState(state) ?? EMPTY;
}

function send(view: EditorView, meta: FindMeta, mutate?: (tr: Transaction) => void): void {
    const tr = view.state.tr.setMeta(wikiFindKey, meta);
    mutate?.(tr);
    view.dispatch(tr);
}

export function openWikiFind(view: EditorView, query?: string): void {
    send(view, {kind: 'open', query});
}

export function closeWikiFind(view: EditorView): void {
    send(view, {kind: 'close'});
}

export function setWikiFindQuery(view: EditorView, patch: Partial<WikiFindQuery>): void {
    send(view, {kind: 'query', patch});
}

export function wikiFindNext(view: EditorView): void {
    step(view, 1);
}

export function wikiFindPrev(view: EditorView): void {
    step(view, -1);
}

function step(view: EditorView, delta: number): void {
    const find = wikiFindState(view.state);
    if (!find.matches.length) return;
    const index = (find.current + delta + find.matches.length) % find.matches.length;
    const match = find.matches[index];
    send(view, {kind: 'current', index}, tr => {
        tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
    });
}

/** Replaces the highlighted match. False when there is nothing to replace or the page is read-only. */
export function wikiFindReplace(view: EditorView, replacement: string): boolean {
    const find = wikiFindState(view.state);
    const match = find.matches[find.current];
    if (!view.editable || !match) return false;
    // No meta: the docChanged branch re-walks the document and lands on the match after this one.
    view.dispatch(view.state.tr.insertText(replacement, match.from, match.to));
    return true;
}

/** Returns how many were replaced. */
export function wikiFindReplaceAll(view: EditorView, replacement: string): number {
    const find = wikiFindState(view.state);
    if (!view.editable || !find.matches.length) return 0;
    const tr = view.state.tr;
    // Back to front in one transaction: earlier positions stay valid, and undo takes the whole
    // replace-all back as a single step.
    for (let i = find.matches.length - 1; i >= 0; i--) {
        const match = find.matches[i];
        tr.insertText(replacement, match.from, match.to);
    }
    view.dispatch(tr);
    return find.matches.length;
}
