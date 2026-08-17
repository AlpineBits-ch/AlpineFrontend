import {Editor, Extension} from '@tiptap/core';
import {EditorState, Plugin, PluginKey} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';
import {columnResizing} from '@tiptap/pm/tables';
import {DEFAULT_WIKI_BLOCK_LABELS, WikiBlockLabels} from './wiki-block-labels';

/** Everything a table needs after insertion: a decoration, not an Angular component, so it needs nothing from the article template. Positioned by the document rather than a floating-element library, it disappears on its own when the caret leaves the table or the page drops back to read mode. */

const CONTROLS_KEY = new PluginKey('wikiTableControls');

/** Matches TableView's `cellMinWidth`, so an unsized column and a dragged one agree on the floor. */
const CELL_MIN_WIDTH = 48;

interface ControlAction {
    id: string;
    icon: string;
    label: (labels: WikiBlockLabels) => string;
    run: (editor: Editor) => void;
    danger?: boolean;
}

const ACTIONS: readonly ControlAction[] = [
    {
        id: 'row-above',
        icon: 'pi-arrow-up',
        label: l => l.tableAddRowAbove,
        run: editor => editor.chain().focus().addRowBefore().run(),
    },
    {
        id: 'row-below',
        icon: 'pi-arrow-down',
        label: l => l.tableAddRowBelow,
        run: editor => editor.chain().focus().addRowAfter().run(),
    },
    {
        id: 'column-left',
        icon: 'pi-arrow-left',
        label: l => l.tableAddColumnLeft,
        run: editor => editor.chain().focus().addColumnBefore().run(),
    },
    {
        id: 'column-right',
        icon: 'pi-arrow-right',
        label: l => l.tableAddColumnRight,
        run: editor => editor.chain().focus().addColumnAfter().run(),
    },
    {
        id: 'header-row',
        icon: 'pi-table',
        label: l => l.tableToggleHeaderRow,
        run: editor => editor.chain().focus().toggleHeaderRow().run(),
    },
    {
        id: 'delete-row',
        icon: 'pi-minus',
        label: l => l.tableDeleteRow,
        danger: true,
        run: editor => editor.chain().focus().deleteRow().run(),
    },
    {
        id: 'delete-column',
        icon: 'pi-minus',
        label: l => l.tableDeleteColumn,
        danger: true,
        run: editor => editor.chain().focus().deleteColumn().run(),
    },
    {
        id: 'delete-table',
        icon: 'pi-trash',
        label: l => l.tableDelete,
        danger: true,
        run: editor => editor.chain().focus().deleteTable().run(),
    },
];

/** Position of the table the selection sits in, or null when it sits outside one. */
function enclosingTable(state: EditorState): number | null {
    const {$from} = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === 'table') return $from.before(depth);
    }
    return null;
}

function buildControls(editor: Editor, labels: WikiBlockLabels): HTMLElement {
    const anchor = document.createElement('div');
    anchor.className = 'wiki-table-controls-anchor';
    anchor.contentEditable = 'false';

    const bar = document.createElement('div');
    bar.className = 'wiki-table-controls';
    anchor.appendChild(bar);

    for (const action of ACTIONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-action', action.id);
        if (action.danger) button.setAttribute('data-danger', 'true');
        const title = action.label(labels);
        button.title = title;
        button.setAttribute('aria-label', title);
        const icon = document.createElement('i');
        icon.className = `pi ${action.icon}`;
        button.appendChild(icon);
        // On mousedown, and suppressed: by the time a click fires the caret has already left the cell, and every one of these commands is defined relative to where the caret is.
        button.addEventListener('mousedown', event => {
            event.preventDefault();
            event.stopPropagation();
            action.run(editor);
        });
        bar.appendChild(button);
    }

    return anchor;
}

function controlsPlugin(editor: Editor, labels: WikiBlockLabels): Plugin {
    return new Plugin({
        key: CONTROLS_KEY,
        props: {
            decorations: state => {
                if (!editor.isEditable) return null;
                const tablePos = enclosingTable(state);
                if (tablePos === null) return null;
                return DecorationSet.create(state.doc, [
                    Decoration.widget(tablePos, () => buildControls(editor, labels), {
                        side: -1,
                        key: 'wiki-table-controls',
                        ignoreSelection: true,
                        stopEvent: () => true,
                    }),
                ]);
            },
        },
    });
}

/** Column resizing, but only while editing. Tiptap's own Table.configure({resizable: true}) decides once at construction by reading editor.isEditable, and this editor is constructed in read mode, so that switch would be permanently off; registering the ProseMirror plugin directly and gating its props on the live value avoids that ordering trap. */
function editableColumnResizing(editor: Editor): Plugin {
    const base = columnResizing({
        handleWidth: 6,
        cellMinWidth: CELL_MIN_WIDTH,
        defaultCellMinWidth: CELL_MIN_WIDTH,
        // The table node view comes from the Table extension; a second one here would be ignored anyway, since direct editor props win over plugin-provided views.
        View: null,
    });
    const props = base.spec.props ?? {};
    const events = props.handleDOMEvents ?? {};

    return new Plugin({
        ...base.spec,
        props: {
            ...props,
            handleDOMEvents: {
                mousemove: (view, event) =>
                    editor.isEditable && events.mousemove?.call(base, view, event) === true,
                mouseleave: (view, event) =>
                    editor.isEditable && events.mouseleave?.call(base, view, event) === true,
                mousedown: (view, event) =>
                    editor.isEditable && events.mousedown?.call(base, view, event) === true,
            },
            decorations: (state: EditorState) =>
                (editor.isEditable ? props.decorations?.call(base, state) : null) ?? null,
        },
    });
}

export interface WikiTableControlsOptions {
    labels: WikiBlockLabels;
}

export const WikiTableControls = Extension.create<WikiTableControlsOptions>({
    name: 'wikiTableControls',

    addOptions() {
        return {labels: DEFAULT_WIKI_BLOCK_LABELS};
    },

    addProseMirrorPlugins() {
        return [editableColumnResizing(this.editor), controlsPlugin(this.editor, this.options.labels)];
    },
});

/** Exported so the Table configuration and the resize plugin cannot drift apart. */
export const WIKI_TABLE_CELL_MIN_WIDTH = CELL_MIN_WIDTH;
