import {Plugin, PluginKey} from '@tiptap/pm/state';

/** The four editor triggers: / for block insertion, [[ for a page link, : for an emoji and @ for a guild member. Written directly against @tiptap/pm rather than pulling in @tiptap/suggestion (not installed); rendering the menus as Angular components rather than detached DOM keeps them themeable with the rest of the app. */

export type SuggestTrigger = '/' | '[[' | ':' | '@';

export interface SuggestState {
    trigger: SuggestTrigger;
    query: string;
    /** Offset within the block where the trigger starts, so the menu can replace it on select. */
    from: number;
}

export const wikiSuggestKey = new PluginKey('wikiSuggest');

/** Brackets count anywhere, and the query keeps spaces because page titles have them. */
const BRACKET_RE = /\[\[([^\]]*)$/;
/** A slash fires anywhere a word could start (beginning of the block or after whitespace), since requiring an empty line made the menu unreachable once anything had been typed. The leading (^|\s) is also the whole guard against false positives: "and/or" and "https://" both have a non-space character in front of the slash, so neither opens the menu. */
const SLASH_RE = /(^|\s)\/([^\s]*)$/;
/** Two characters of query before the emoji menu opens at all: with one, "note: a", "12:3" and every other colon in prose pops a picker. The charset stops at the closing colon of :smile:, so a shortcode already finished does not re-open it. */
const EMOJI_RE = /(^|\s):([a-zA-Z0-9_+-]{2,})$/;
/** Mentions open on the bare `@`: the useful thing there is the member list itself. */
const MENTION_RE = /(^|\s)@([\w.-]*)$/;

export function matchTrigger(textBefore: string): SuggestState | null {
    // An unclosed [[ swallows the rest of the line, so it is tested first: everything typed inside it (slashes, colons and at-signs included) is part of the page title being searched.
    const bracket = BRACKET_RE.exec(textBefore);
    if (bracket) return {trigger: '[[', query: bracket[1], from: bracket.index};

    const slash = SLASH_RE.exec(textBefore);
    if (slash) return {trigger: '/', query: slash[2], from: slash.index + slash[1].length};

    const emoji = EMOJI_RE.exec(textBefore);
    if (emoji) return {trigger: ':', query: emoji[2], from: emoji.index + emoji[1].length};

    const mention = MENTION_RE.exec(textBefore);
    if (mention) return {trigger: '@', query: mention[2], from: mention.index + mention[1].length};

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
