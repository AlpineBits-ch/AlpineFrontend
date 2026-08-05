import {Plugin, PluginKey} from '@tiptap/pm/state';

/**
 * The two editor triggers: `/` for block insertion, `[[` for a page link.
 *
 * Written directly against @tiptap/pm rather than pulling in @tiptap/suggestion, which is not
 * installed. Doing it here also means the menus render as Angular components instead of detached
 * DOM, so they stay themeable with the rest of the app.
 */

export type SuggestTrigger = '/' | '[[';

export interface SuggestState {
    trigger: SuggestTrigger;
    query: string;
    /** Offset within the block where the trigger starts, so the menu can replace it on select. */
    from: number;
}

export const wikiSuggestKey = new PluginKey('wikiSuggest');

/** A slash only counts at the very start of a block, or "and/or" would open the block menu. */
const SLASH_RE = /^\/([^\s]*)$/;
/** Brackets count anywhere, and the query keeps spaces because page titles have them. */
const BRACKET_RE = /\[\[([^\]]*)$/;

export function matchTrigger(textBefore: string): SuggestState | null {
    const slash = SLASH_RE.exec(textBefore);
    if (slash) return {trigger: '/', query: slash[1], from: 0};

    const bracket = BRACKET_RE.exec(textBefore);
    if (bracket) return {trigger: '[[', query: bracket[1], from: bracket.index};

    return null;
}

export function wikiSuggestPlugin(onChange: (state: SuggestState | null) => void): Plugin {
    return new Plugin({
        key: wikiSuggestKey,
        view: () => ({
            update: view => {
                const {selection} = view.state;
                if (!selection.empty) {
                    onChange(null);
                    return;
                }
                const {$from} = selection;
                const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
                onChange(matchTrigger(textBefore));
            },
        }),
    });
}
