import {Editor} from '@tiptap/core';
import {WikiEditorKeybindId} from '../../../../../models/keybind-action.model';

/** The one formatting table, shared by the toolbar, the bubble menu and the configurable keymap. Keyed by the keybind id so a chip can be printed anywhere the action is offered. */

/** Something no editor chain can do, because the state it needs lives on the article. */
export type WikiFormatHostAction = 'toggle-markdown' | 'link';

export interface WikiFormatAction {
    id: WikiEditorKeybindId;
    titleKey: string;
    /** Text glyph. PrimeIcons has no bold/italic/underline/strike, and letters read better anyway. */
    label?: string;
    icon?: string;
    className?: string;
    /** Mark or node name for the active check. */
    active?: string;
    attrs?: Record<string, unknown>;
    /** Absent on the two host actions below. */
    run?: (editor: Editor) => void;
    host?: WikiFormatHostAction;
}

export const WIKI_FORMAT_ACTIONS: Readonly<Record<WikiEditorKeybindId, WikiFormatAction>> = {
    'wiki-toggle-markdown': {
        id: 'wiki-toggle-markdown',
        titleKey: 'WIKI.TOOLBAR.SOURCE_ON',
        icon: 'pi-code',
        host: 'toggle-markdown',
    },
    'wiki-link': {
        id: 'wiki-link',
        titleKey: 'WIKI.FORMAT.LINK',
        icon: 'pi-link',
        active: 'link',
        host: 'link',
    },
    'wiki-bold': {
        id: 'wiki-bold',
        titleKey: 'WIKI.FORMAT.BOLD',
        label: 'B',
        className: 'font-bold',
        active: 'bold',
        run: editor => editor.chain().focus().toggleBold().run(),
    },
    'wiki-italic': {
        id: 'wiki-italic',
        titleKey: 'WIKI.FORMAT.ITALIC',
        label: 'I',
        className: 'italic',
        active: 'italic',
        run: editor => editor.chain().focus().toggleItalic().run(),
    },
    'wiki-underline': {
        id: 'wiki-underline',
        titleKey: 'WIKI.FORMAT.UNDERLINE',
        label: 'U',
        className: 'underline',
        active: 'underline',
        run: editor => editor.chain().focus().toggleUnderline().run(),
    },
    'wiki-strike': {
        id: 'wiki-strike',
        titleKey: 'WIKI.FORMAT.STRIKETHROUGH',
        label: 'S',
        className: 'line-through',
        active: 'strike',
        run: editor => editor.chain().focus().toggleStrike().run(),
    },
    'wiki-inline-code': {
        id: 'wiki-inline-code',
        titleKey: 'WIKI.FORMAT.INLINE_CODE',
        label: '<>',
        className: 'font-mono text-[0.6875rem]',
        active: 'code',
        run: editor => editor.chain().focus().toggleCode().run(),
    },
    'wiki-heading-1': {
        id: 'wiki-heading-1',
        titleKey: 'WIKI.BLOCK.HEADING_1',
        label: 'H1',
        className: 'text-[0.6875rem] font-bold',
        active: 'heading',
        attrs: {level: 1},
        run: editor => editor.chain().focus().toggleHeading({level: 1}).run(),
    },
    'wiki-heading-2': {
        id: 'wiki-heading-2',
        titleKey: 'WIKI.BLOCK.HEADING_2',
        label: 'H2',
        className: 'text-[0.6875rem] font-bold',
        active: 'heading',
        attrs: {level: 2},
        run: editor => editor.chain().focus().toggleHeading({level: 2}).run(),
    },
    'wiki-heading-3': {
        id: 'wiki-heading-3',
        titleKey: 'WIKI.BLOCK.HEADING_3',
        label: 'H3',
        className: 'text-[0.6875rem] font-bold',
        active: 'heading',
        attrs: {level: 3},
        run: editor => editor.chain().focus().toggleHeading({level: 3}).run(),
    },
    'wiki-bullet-list': {
        id: 'wiki-bullet-list',
        titleKey: 'WIKI.BLOCK.BULLET_LIST',
        icon: 'pi-list',
        active: 'bulletList',
        run: editor => editor.chain().focus().toggleBulletList().run(),
    },
    'wiki-numbered-list': {
        id: 'wiki-numbered-list',
        titleKey: 'WIKI.BLOCK.NUMBERED_LIST',
        icon: 'pi-sort-numeric-up-alt',
        active: 'orderedList',
        run: editor => editor.chain().focus().toggleOrderedList().run(),
    },
    'wiki-task-list': {
        id: 'wiki-task-list',
        titleKey: 'WIKI.BLOCK.TASK_LIST',
        icon: 'pi-check-square',
        active: 'taskList',
        run: editor => editor.chain().focus().toggleTaskList().run(),
    },
    'wiki-quote': {
        id: 'wiki-quote',
        titleKey: 'WIKI.BLOCK.QUOTE',
        label: '❝',
        icon: 'pi-comment',
        active: 'blockquote',
        run: editor => editor.chain().focus().toggleBlockquote().run(),
    },
    'wiki-code-block': {
        id: 'wiki-code-block',
        titleKey: 'WIKI.BLOCK.CODE_BLOCK',
        icon: 'pi-code',
        active: 'codeBlock',
        run: editor => editor.chain().focus().toggleCodeBlock().run(),
    },
    'wiki-divider': {
        id: 'wiki-divider',
        titleKey: 'WIKI.BLOCK.DIVIDER',
        icon: 'pi-minus',
        run: editor => editor.chain().focus().setHorizontalRule().run(),
    },
};

export const WIKI_FORMAT_ACTION_IDS = Object.keys(WIKI_FORMAT_ACTIONS) as WikiEditorKeybindId[];

/** The inline marks the toolbar and the bubble menu both offer, in the order they render. */
export const WIKI_INLINE_FORMAT_IDS: readonly WikiEditorKeybindId[] = [
    'wiki-bold',
    'wiki-italic',
    'wiki-underline',
    'wiki-strike',
    'wiki-inline-code',
];

/** The block conversions the bubble menu keeps beside the marks, since a selection is what they act on. */
export const WIKI_BUBBLE_BLOCK_IDS: readonly WikiEditorKeybindId[] = [
    'wiki-heading-1',
    'wiki-heading-2',
    'wiki-heading-3',
    'wiki-quote',
];

export function wikiFormatActions(ids: readonly WikiEditorKeybindId[]): WikiFormatAction[] {
    return ids.map(id => WIKI_FORMAT_ACTIONS[id]);
}

/** False while source mode is open, where every one of these is inert against a raw textarea. */
export function isFormatActive(action: WikiFormatAction, editor: Editor | undefined): boolean {
    if (!action.active || !editor) return false;
    return editor.isActive(action.active, action.attrs);
}
