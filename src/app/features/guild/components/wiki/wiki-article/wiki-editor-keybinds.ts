import {Editor, Extension} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';
import {WikiEditorKeybindId} from '../../../../../models/keybind-action.model';
import {acceleratorFromEvent} from '../../../../../services/keybinds.service';

/**
 * The configurable half of the editor's keyboard.
 *
 * TipTap binds most of these itself, but its keymaps are fixed at construction and invisible to
 * the user - so "let me change the shortcut for a quote" has no answer while they own the key.
 * This plugin is asked first and consumes anything it recognises, which makes the stored binding
 * the one that decides. The built-in keys survive underneath as a fallback for anything left
 * unbound.
 *
 * Two of the actions are not editor commands at all - switching to markdown source replaces the
 * surface, and the link row lives on the toolbar - so the host passes those in.
 */

/** Above the block extensions, so a rebound key is not first eaten by the default that owns it. */
const KEYBIND_PRIORITY = 1000;

export interface WikiKeybindHost {
    /** Swap between the rich surface and the raw markdown textarea. */
    toggleMarkdown(): void;
    /** Open the toolbar's link row against the current selection. */
    openLink(): void;
}

export interface WikiEditorKeybindOptions {
    /** Read on every keystroke, so a rebind takes effect without rebuilding the editor. */
    binding: (id: WikiEditorKeybindId) => string | null;
    host: WikiKeybindHost;
    /** Shortcuts that change the document do nothing while the page is only being read. */
    editable: () => boolean;
}

/**
 * What each action does. Everything here either wraps the selection or converts the block the
 * caret is in - which is what "keybinds should wrap highlighted text" asks for, and is TipTap's
 * own behaviour for every one of these toggles.
 */
type EditorAction = (editor: Editor, host: WikiKeybindHost) => void;

const ACTIONS: Record<WikiEditorKeybindId, EditorAction> = {
    'wiki-toggle-markdown': (_editor, host) => host.toggleMarkdown(),
    'wiki-link': (_editor, host) => host.openLink(),
    'wiki-bold': editor => editor.chain().focus().toggleBold().run(),
    'wiki-italic': editor => editor.chain().focus().toggleItalic().run(),
    'wiki-underline': editor => editor.chain().focus().toggleUnderline().run(),
    'wiki-strike': editor => editor.chain().focus().toggleStrike().run(),
    'wiki-inline-code': editor => editor.chain().focus().toggleCode().run(),
    'wiki-heading-1': editor => editor.chain().focus().toggleHeading({level: 1}).run(),
    'wiki-heading-2': editor => editor.chain().focus().toggleHeading({level: 2}).run(),
    'wiki-heading-3': editor => editor.chain().focus().toggleHeading({level: 3}).run(),
    'wiki-bullet-list': editor => editor.chain().focus().toggleBulletList().run(),
    'wiki-numbered-list': editor => editor.chain().focus().toggleOrderedList().run(),
    'wiki-task-list': editor => editor.chain().focus().toggleTaskList().run(),
    'wiki-quote': editor => editor.chain().focus().toggleBlockquote().run(),
    'wiki-code-block': editor => editor.chain().focus().toggleCodeBlock().run(),
    'wiki-divider': editor => editor.chain().focus().setHorizontalRule().run(),
};

/** The one action that still applies to a page you are only reading. */
const READ_ONLY_ACTIONS: ReadonlySet<WikiEditorKeybindId> = new Set(['wiki-toggle-markdown']);

const ACTION_IDS = Object.keys(ACTIONS) as WikiEditorKeybindId[];

export function wikiEditorKeybinds(options: WikiEditorKeybindOptions): Extension {
    return Extension.create({
        name: 'wikiEditorKeybinds',
        priority: KEYBIND_PRIORITY,

        addProseMirrorPlugins() {
            const editor = this.editor;
            return [
                new Plugin({
                    key: new PluginKey('wikiEditorKeybinds'),
                    props: {
                        handleKeyDown: (_view, event) => {
                            // A bare modifier is half a combination, not a shortcut. Matching on
                            // it would fire the action as soon as Ctrl went down.
                            if (isModifierOnly(event)) return false;

                            const pressed = acceleratorFromEvent(event);
                            const id = ACTION_IDS.find(
                                action => options.binding(action) === pressed,
                            );
                            if (!id) return false;
                            if (!options.editable() && !READ_ONLY_ACTIONS.has(id)) return false;

                            // Consumed either way: the key belongs to this action now, and letting
                            // it fall through would run the built-in default on top of it.
                            event.preventDefault();
                            ACTIONS[id](editor, options.host);
                            return true;
                        },
                    },
                }),
            ];
        },
    });
}

function isModifierOnly(event: KeyboardEvent): boolean {
    return event.key === 'Control' || event.key === 'Alt'
        || event.key === 'Shift' || event.key === 'Meta';
}
