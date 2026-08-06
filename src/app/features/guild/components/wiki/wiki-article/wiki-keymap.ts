import {Extension, InputRule} from '@tiptap/core';
import {EditorState, Transaction} from '@tiptap/pm/state';

/**
 * The keys the block extensions do not agree on between them.
 *
 * Two separate problems, both of which look to a user like "the editor ignored me":
 *
 * 1. Tab. Every list item extension binds it for itself, so it indents inside a bullet list and
 *    moves between table cells - and does nothing at all anywhere else, which in a contenteditable
 *    means the browser's default runs and focus leaves the document. Landing on the previous
 *    checkbox is what that looks like from the outside. {@link WikiTabGuard} is the floor under
 *    all of them: whatever nothing else claimed, Tab still belongs to the editor.
 *
 * 2. `- [ ]`. The bullet-list input rule fires on the space after the dash, so the list item exists
 *    before the brackets can be typed, and the task-item rule that would have caught `[ ] ` never
 *    matches inside one. {@link WikiTaskFromListItem} catches it there instead.
 */

/**
 * Deliberately below default priority.
 *
 * Registered ahead of the list and table keymaps, this would swallow Tab before either of them
 * could indent anything. It is a fallback, and a fallback has to be asked last.
 */
const TAB_GUARD_PRIORITY = 50;

export const WikiTabGuard = Extension.create({
    name: 'wikiTabGuard',
    priority: TAB_GUARD_PRIORITY,

    addKeyboardShortcuts() {
        // Always true, whichever branch ran: that is what stops the browser's default and keeps
        // focus in the article.
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

/**
 * What one press is worth.
 *
 * Non-breaking spaces, not a tab character. A tab is what a text editor inserts, but this document
 * is stored as markdown, and there a tab at the start of a line means an indented code block - so
 * indenting a paragraph and reloading the page turned the paragraph into code. Non-breaking spaces
 * carry no meaning in markdown, survive the round trip verbatim, and render as the same visible
 * step in both edit and read mode.
 */
const INDENT = ' '.repeat(4);

/**
 * Indents at the caret.
 *
 * Reached only when nothing above claimed the key, so a list still indents its item and a table
 * still moves a cell. Everywhere else Tab does what it does in a text editor: it puts a tab in.
 */
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
                    // Only inside a bullet or numbered item. In a bare paragraph the task-item
                    // extension's own rule already handles this, and running both would fight.
                    const inListItem = $from.node(-1)?.type.name === 'listItem';
                    if (!inListItem) return null;
                    // The rule matches at the start of the textblock only; anywhere else `[ ]` is
                    // just something somebody wrote.
                    if ($from.parentOffset !== range.to - range.from) return null;

                    const checked = match[1].toLowerCase() === 'x';

                    // `toggleTaskList` from inside a bullet list converts that list in place -
                    // there is no need to lift the item out first, and trying to did nothing but
                    // leave a bare paragraph behind.
                    //
                    // It converts the *whole* list, which is the right answer for the case this
                    // exists to serve: typing `- ` and then `[ ] ` while starting a fresh list.
                    // Deciding that the second item of an established bullet list is secretly a
                    // checklist would be the surprising reading.
                    let steps = chain().deleteRange(range).toggleTaskList();
                    if (checked) steps = steps.updateAttributes('taskItem', {checked: true});
                    steps.run();
                    return undefined;
                },
            }),
        ];
    },
});
