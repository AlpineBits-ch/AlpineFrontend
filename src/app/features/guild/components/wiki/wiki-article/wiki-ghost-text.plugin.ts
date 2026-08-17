import {Plugin, PluginKey, TextSelection} from '@tiptap/pm/state';
import {Decoration, DecorationSet, EditorView} from '@tiptap/pm/view';

/** Inline autocomplete: a grey continuation of the sentence you stopped in the middle of. Gated narrowly in {@link shouldSuggest}, aborted on every keystroke, and limited to a single-line result, since it costs the user's own API credit on every pause and a suggestion that appears mid-type is worse than none. Tab accepts; anything else dismisses; Esc dismisses and stays quiet until you type again. */

export interface WikiGhostTextRequest {
    before: string;
    after: string;
    title: string;
}

export interface WikiGhostTextOptions {
    /** Read on every pause, so flipping the setting takes effect without rebuilding the editor. */
    enabled: () => boolean;
    title: () => string;
    complete: (req: WikiGhostTextRequest, signal: AbortSignal) => Promise<string>;
    /** Typing pause before a request goes out. */
    debounceMs?: number;
    /** Characters of context sent on either side of the caret. */
    beforeChars?: number;
    afterChars?: number;
}

interface GhostState {
    text: string;
    pos: number;
}

type GhostMeta = {type: 'set'; text: string; pos: number} | {type: 'clear'};

export const wikiGhostTextKey = new PluginKey<GhostState | null>('wikiGhostText');

const DEFAULT_DEBOUNCE_MS = 600;
const DEFAULT_BEFORE_CHARS = 1200;
const DEFAULT_AFTER_CHARS = 400;
/** Below this much text in the current block there is nothing to continue from. */
const MIN_BLOCK_CONTEXT = 3;

/** A /, [[, : or @ run means one of the trigger menus is open or about to be; matched locally rather than by importing the trigger plugin, since all this needs to know is that something else owns this keystroke. */
const TRIGGER_RUN_RE = /(?:^|\s)[/:@]\S*$|\[\[[^\]]*$/;

/** Keys that are part of typing, not a verdict on the suggestion. */
const PASSIVE_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

export function wikiGhostTextPlugin(options: WikiGhostTextOptions): Plugin {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const beforeChars = options.beforeChars ?? DEFAULT_BEFORE_CHARS;
    const afterChars = options.afterChars ?? DEFAULT_AFTER_CHARS;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    /** Set by Esc; lifted by the next document change. */
    let suppressed = false;
    /** Accepting is itself a document change, and must not immediately ask for the next one. */
    let justAccepted = false;
    /** Rises on every request so a late response for an older caret can be dropped. */
    let token = 0;

    const cancelPending = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
        token++;
    };

    const clear = (view: EditorView) => {
        if (!wikiGhostTextKey.getState(view.state)) return;
        view.dispatch(view.state.tr.setMeta(wikiGhostTextKey, {type: 'clear'} satisfies GhostMeta));
    };

    const request = (view: EditorView) => {
        const pos = view.state.selection.from;
        const mine = ++token;
        const current = new AbortController();
        controller = current;

        const doc = view.state.doc;
        const before = doc
            .textBetween(Math.max(0, pos - beforeChars * 2), pos, '\n\n', ' ')
            .slice(-beforeChars);
        const after = doc
            .textBetween(pos, Math.min(doc.content.size, pos + afterChars * 2), '\n\n', ' ')
            .slice(0, afterChars);

        void options
            .complete({before, after, title: options.title()}, current.signal)
            .then(result => {
                // Three ways this answer can already be stale: a newer request, a moved caret, or an edit that landed while it was in flight; all three make it wrong to show.
                if (mine !== token || current.signal.aborted) return;
                if (view.state.selection.from !== pos || !view.state.selection.empty) return;
                const text = firstLine(result);
                if (!text) return;
                view.dispatch(
                    view.state.tr.setMeta(wikiGhostTextKey, {
                        type: 'set',
                        text,
                        pos,
                    } satisfies GhostMeta),
                );
            })
            .catch(() => {
                // A failed completion is silent on purpose: nothing was asked for out loud, so there is nothing to apologise for, and an error toast on a typing pause would be the most irritating error in the app.
            });
    };

    return new Plugin<GhostState | null>({
        key: wikiGhostTextKey,

        state: {
            init: () => null,
            apply: (tr, value) => {
                const meta = tr.getMeta(wikiGhostTextKey) as GhostMeta | undefined;
                if (meta?.type === 'set') return {text: meta.text, pos: meta.pos};
                if (meta?.type === 'clear') return null;
                if (!value) return null;
                // Any edit or caret move invalidates a suggestion computed for the old position.
                return tr.docChanged || tr.selectionSet ? null : value;
            },
        },

        props: {
            decorations: state => {
                const ghost = wikiGhostTextKey.getState(state);
                if (!ghost) return null;
                return DecorationSet.create(state.doc, [
                    Decoration.widget(ghost.pos, () => ghostElement(ghost.text), {
                        side: 1,
                        // Without this the widget counts as a selection boundary and the caret jumps to the far side of the suggestion.
                        ignoreSelection: true,
                        key: `ghost:${ghost.pos}:${ghost.text}`,
                    }),
                ]);
            },

            handleKeyDown: (view, event) => {
                // Unconditional: a request in flight is a request for a caret that is about to move, whether or not a suggestion is currently on screen.
                if (!PASSIVE_KEYS.has(event.key)) cancelPending();

                const ghost = wikiGhostTextKey.getState(view.state);
                if (!ghost) return false;

                if (event.key === 'Tab') {
                    const tr = view.state.tr.insertText(ghost.text, ghost.pos);
                    tr.setSelection(TextSelection.create(tr.doc, ghost.pos + ghost.text.length));
                    tr.setMeta(wikiGhostTextKey, {type: 'clear'} satisfies GhostMeta);
                    justAccepted = true;
                    view.dispatch(tr);
                    return true;
                }
                if (event.key === 'Escape') {
                    suppressed = true;
                    clear(view);
                    return true;
                }
                if (PASSIVE_KEYS.has(event.key)) return false;

                // Every other key dismisses, and does not consume: the keystroke was meant for the document.
                clear(view);
                return false;
            },
        },

        view: () => ({
            update: (view, prevState) => {
                const docChanged = !view.state.doc.eq(prevState.doc);
                const selectionChanged = !view.state.selection.eq(prevState.selection);
                if (!docChanged && !selectionChanged) return;

                if (docChanged) suppressed = false;
                cancelPending();

                if (justAccepted) {
                    justAccepted = false;
                    return;
                }
                // Only typing starts the clock: clicking around a document is navigation, and suggesting text at every place the caret lands is how this feature becomes something people turn off.
                if (!docChanged || suppressed || !shouldSuggest(view)) return;

                timer = setTimeout(() => {
                    timer = undefined;
                    if (shouldSuggest(view)) request(view);
                }, debounceMs);
            },
            destroy: () => cancelPending(),
        }),
    });

    function shouldSuggest(view: EditorView): boolean {
        if (!options.enabled() || !view.editable) return false;

        const {selection} = view.state;
        if (!selection.empty) return false;

        const {$from} = selection;
        // Code is the one place a plausible-looking continuation is actively dangerous: it reads as something that was checked, and nothing here checked it.
        for (let depth = $from.depth; depth >= 0; depth--) {
            if ($from.node(depth).type.spec.code) return false;
        }
        if ($from.parent.type.name === 'codeBlock') return false;
        if (selection.$from.marks().some(mark => mark.type.spec.code)) return false;

        const parent = $from.parent;
        if (!parent.isTextblock) return false;
        if ($from.parentOffset < MIN_BLOCK_CONTEXT) return false;

        // Mid-word and mid-sentence completions fight the user for the same characters; only a caret with nothing after it in its own block has room to continue.
        const after = parent.textBetween($from.parentOffset, parent.content.size, '\n', ' ');
        if (after.trim()) return false;

        const before = parent.textBetween(0, $from.parentOffset, '\n', ' ');
        if (TRIGGER_RUN_RE.test(before)) return false;
        // A block that is only whitespace has no sentence to continue.
        return !!before.trim();
    }
}

/** One line only: a multi-paragraph ghost is unreadable as an overlay, and insertText would put its newlines inside a single paragraph as literal characters. */
function firstLine(completion: string): string {
    const line = completion.split('\n')[0]?.replace(/\s+$/, '') ?? '';
    return line.trim() ? line : '';
}

function ghostElement(text: string): HTMLElement {
    const span = document.createElement('span');
    span.className = 'wiki-ghost-text';
    // Styled inline rather than from the article's stylesheet: this plugin has to be droppable into the editor without a matching CSS change landing in a file it does not own.
    span.style.opacity = '0.34';
    span.style.pointerEvents = 'none';
    span.style.whiteSpace = 'pre-wrap';
    span.style.userSelect = 'none';
    span.textContent = text;
    // Announcing it would interleave a suggestion with what the user actually typed.
    span.setAttribute('aria-hidden', 'true');
    return span;
}
