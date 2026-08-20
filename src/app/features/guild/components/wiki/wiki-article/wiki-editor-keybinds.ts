import {Extension} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';
import {WikiEditorKeybindId} from '../../../../../models/keybind-action.model';
import {acceleratorFromEvent} from '../../../../../services/keybinds.service';
import {WIKI_FORMAT_ACTION_IDS, WIKI_FORMAT_ACTIONS} from './wiki-format-actions';

/** The configurable half of the editor's keyboard: TipTap's own keymaps are fixed at construction and invisible to the user, so this plugin is asked first (priority) and consumes anything it recognises, making the stored binding win; unbound keys fall through to TipTap's defaults. Two actions (the markdown-source toggle, the toolbar's link row) are not editor commands, so the host passes those in. */

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

/** The one action that still applies to a page you are only reading. */
const READ_ONLY_ACTIONS: ReadonlySet<WikiEditorKeybindId> = new Set(['wiki-toggle-markdown']);

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
                            // A bare modifier is half a combination, not a shortcut; matching on it would fire the action as soon as Ctrl went down.
                            if (isModifierOnly(event)) return false;

                            const pressed = acceleratorFromEvent(event);
                            const id = WIKI_FORMAT_ACTION_IDS.find(
                                action => options.binding(action) === pressed,
                            );
                            if (!id) return false;
                            if (!options.editable() && !READ_ONLY_ACTIONS.has(id)) return false;

                            // Consumed either way: the key belongs to this action now, and letting it fall through would run the built-in default on top of it.
                            event.preventDefault();
                            const action = WIKI_FORMAT_ACTIONS[id];
                            if (action.host === 'toggle-markdown') options.host.toggleMarkdown();
                            else if (action.host === 'link') options.host.openLink();
                            else action.run?.(editor);
                            return true;
                        },
                    },
                }),
            ];
        },
    });
}

function isModifierOnly(event: KeyboardEvent): boolean {
    return event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift' || event.key === 'Meta';
}
