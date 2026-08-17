import {Extension, InputRule} from '@tiptap/core';
import {EditorState, Transaction} from '@tiptap/pm/state';

/** The keys the block extensions do not agree on between them: (1) Tab is bound per-extension (indents in a list, moves table cells) but does nothing elsewhere, so the browser's default steals focus; {@link WikiTabGuard} is the floor under all of them. (2) The bullet-list input rule fires before `[ ]` can be typed, so the task-item rule never matches inside a fresh list item; {@link WikiTaskFromListItem} catches it there instead. */

/** Deliberately below default priority: registered ahead of the list and table keymaps, this would swallow Tab before either of them could indent anything. */
const TAB_GUARD_PRIORITY = 50;

export const WikiTabGuard = Extension.create({
    name: 'wikiTabGuard',
    priority: TAB_GUARD_PRIORITY,

    addKeyboardShortcuts() {
        // Always true, whichever branch ran: that is what stops the browser's default and keeps focus in the article.
        return {
            Tab: ({editor}) => {
                editor.commands.command(({state, dispatch}) => indent(state, dispatch));
                return true;
            },
            'Shift-Tab': ({editor}) => {
                editor.commands.command(({state, dispatch}) => outdent(state, dispatch));
                return true;
            },
        };
    },
});

/** Non-breaking spaces, not a tab character: a tab at the start of a line means an indented code block in markdown, so indenting a paragraph and reloading would turn it into code; non-breaking spaces carry no meaning in markdown and survive the round trip verbatim. */
const INDENT = ' '.repeat(4);

/** Indents at the caret; reached only when nothing above claimed the key, so a list still indents its item and a table still moves a cell. */
function indent(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined): boolean {
    if (dispatch) {
        const {from, to} = state.selection;
        dispatch(state.tr.insertText(INDENT, from, to).scrollIntoView());
    }
    return true;
}

/** Takes one step back off, where what is before the caret is a step this put there. */
function outdent(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined): boolean {
    const {empty, from} = state.selection;
    if (!empty) return false;
    const start = from - INDENT.length;
    if (start < 0) return false;
    if (state.doc.textBetween(start, from) !== INDENT) return false;
    if (dispatch) dispatch(state.tr.delete(start, from).scrollIntoView());
    return true;
}

/** `[ ]`, `[x]` or `[]` followed by the space that commits it, at the start of a list item. */
const TASK_MARKER = /^\[([ xX]?)]\s$/;

export const WikiTaskFromListItem = Extension.create({
    name: 'wikiTaskFromListItem',

    addInputRules() {
        return [
            new InputRule({
                find: TASK_MARKER,
                handler: ({state, range, match, chain}) => {
                    const {$from} = state.selection;
                    // Only inside a bullet or numbered item; in a bare paragraph the task-item extension's own rule already handles this, and running both would fight.
                    const inListItem = $from.node(-1)?.type.name === 'listItem';
                    if (!inListItem) return null;
                    // The rule matches at the start of the textblock only; anywhere else [ ] is just something somebody wrote.
                    if ($from.parentOffset !== range.to - range.from) return null;

                    const checked = match[1].toLowerCase() === 'x';

                    // toggleTaskList from inside a bullet list converts that list in place, with
                    // no need to lift the item out first; it converts the whole list, which is
                    // right for the case this serves (typing "- " then "[ ] " to start a fresh
                    // list), not for turning the second item of an established list into a
                    // checklist.
                    let steps = chain().deleteRange(range).toggleTaskList();
                    if (checked) steps = steps.updateAttributes('taskItem', {checked: true});
                    steps.run();
                    return undefined;
                },
            }),
        ];
    },
});
