import {Extension, InputRule} from '@tiptap/core';
import {ResolvedPos} from '@tiptap/pm/model';

/** The keys the block extensions do not agree on between them: (1) Tab is bound per-extension (indents in a list, moves table cells) but does nothing elsewhere; {@link WikiTabGuard} decides what happens when none of them claimed it. (2) The bullet-list input rule fires before `[ ]` can be typed, so the task-item rule never matches inside a fresh list item; {@link WikiTaskFromListItem} catches it there instead. */

/** Deliberately below default priority: registered ahead of the list and table keymaps, this would swallow Tab before either of them could indent anything. */
const TAB_GUARD_PRIORITY = 50;

/** Structures whose own keymap owns Tab. Reaching the guard inside one means it declined (the first item of a list has nothing to sink under), and moving focus out of a half-indented list is worse than doing nothing. */
const TAB_HOLDERS: ReadonlySet<string> = new Set([
    'listItem',
    'taskItem',
    'table',
    'tableRow',
    'tableCell',
    'tableHeader',
]);

export const WikiTabGuard = Extension.create({
    name: 'wikiTabGuard',
    priority: TAB_GUARD_PRIORITY,

    addKeyboardShortcuts() {
        // False in prose is what lets the browser move focus on: consuming Tab everywhere left the
        // article with no keyboard exit at all.
        return {
            Tab: ({editor}) => holdsTab(editor.state.selection.$from),
            'Shift-Tab': ({editor}) => holdsTab(editor.state.selection.$from),
            Escape: ({editor}) => {
                if (!editor.isFocused) return false;
                editor.commands.blur();
                return true;
            },
        };
    },
});

function holdsTab($from: ResolvedPos): boolean {
    for (let depth = $from.depth; depth > 0; depth--) {
        if (TAB_HOLDERS.has($from.node(depth).type.name)) return true;
    }
    return false;
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
