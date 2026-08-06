import {Editor} from '@tiptap/core';
import {Slice} from '@tiptap/pm/model';

/**
 * Writes a model's output into the document while it is still arriving, reversibly.
 *
 * The whole point of the inline bar is that you read the result in the page, in its own
 * typography, next to the paragraph it has to sit beside - not in a preview pane that looks
 * nothing like the destination. That only works if the preview can be taken back exactly.
 *
 * So the streamed text never enters the undo history: every intermediate write carries
 * `addToHistory: false`, and the range is put back from the original ProseMirror slice rather
 * than from a markdown round-trip, which would not survive anything the serializer normalises.
 * Accept then rewinds the preview and re-applies the finished text as **one** ordinary
 * transaction, so a single ⌘Z removes the generation and nothing else.
 */
export class WikiAiDocStream {
    private start = 0;
    private end = 0;
    private originalLength = 0;
    private original = Slice.empty;
    private live = false;

    /**
     * @param editor the surface being written into.
     * @param restoreEditable what the editor's editable flag should be when this stream is done.
     *        Read at finish time rather than captured at begin time: the article can leave edit
     *        mode mid-stream, and restoring the flag we saw when we started would put a read-only
     *        page back into an editable state nobody asked for.
     */
    constructor(
        private readonly editor: Editor,
        private readonly restoreEditable: () => boolean,
    ) {
    }

    get active(): boolean {
        return this.live;
    }

    /** Where the generated text currently ends, for anchoring UI to it. */
    get endPos(): number {
        return this.end;
    }

    /**
     * Takes ownership of a range. `from === to` is an insertion; anything wider is a replacement,
     * and the replaced content is held so Discard can put it back byte for byte.
     */
    begin(from: number, to: number): void {
        this.start = from;
        this.end = to;
        this.originalLength = to - from;
        this.original = this.editor.state.doc.slice(from, to);
        this.live = true;
        // The owned range is tracked by arithmetic over our own edits, so a keystroke landing
        // inside it would silently shift it out from under us. Locking the surface for the few
        // seconds a generation takes is more honest than racing the user for the same positions.
        this.editor.setEditable(false, false);
    }

    /**
     * Replaces the owned range with `markdown`. Called repeatedly as chunks arrive; each call
     * re-parses the accumulated text so the preview is formatted rather than raw.
     */
    write(markdown: string): void {
        if (!this.live) return;
        const text = markdown.replace(/\s+$/, '');
        if (!text) {
            this.rewind();
            return;
        }
        const before = this.editor.state.doc.content.size;
        this.editor.chain()
            .setMeta('addToHistory', false)
            .insertContentAt({from: this.start, to: this.end}, text, {
                contentType: 'markdown',
                updateSelection: false,
                // A model that writes "1. " or "> " means a list or a quote, which the markdown
                // parser has already produced. Letting input rules fire on top of that would
                // transform the same syntax twice.
                applyInputRules: false,
                applyPasteRules: false,
            })
            .run();
        // The insertion is contained in the range, so the document's size delta *is* the range's.
        this.end += this.editor.state.doc.content.size - before;
    }

    /** Puts the original content back without recording it. Retry re-runs from this state. */
    rewind(): void {
        if (!this.live) return;
        // Unconditional, even when the range is the same length it started as: a rewrite can
        // come back the same size as the text it replaced, and a length check would then leave
        // the model's version sitting in the document under a "discarded" label.
        const tr = this.editor.state.tr;
        tr.replace(this.start, this.end, this.original);
        tr.setMeta('addToHistory', false);
        this.editor.view.dispatch(tr);
        this.end = this.start + this.originalLength;
    }

    /**
     * Keeps `markdown` as the result: one history entry for the whole generation.
     *
     * The article's draft debounce restarts on this transaction like any other edit, so the
     * accepted text autosaves as a draft without this file knowing anything about drafts.
     */
    accept(markdown: string): void {
        if (!this.live) return;
        this.rewind();
        // Unlocked before the result is applied, not after: `.focus()` against a surface that is
        // still `contenteditable=false` does not take, and the caret would be left nowhere.
        const editable = this.unlock();
        const text = markdown.trim();
        if (text) {
            const before = this.editor.state.doc.content.size;
            const chain = editable ? this.editor.chain().focus() : this.editor.chain();
            chain.insertContentAt({from: this.start, to: this.end}, text, {
                contentType: 'markdown',
                updateSelection: true,
                applyInputRules: false,
                applyPasteRules: false,
            }).run();
            this.end += this.editor.state.doc.content.size - before;
        }
        this.finish();
    }

    /**
     * Restores the document, and the selection with it - a discarded rewrite should leave the
     * text you had selected still selected, ready for a different action.
     */
    discard(): void {
        if (!this.live) return;
        this.rewind();
        const editable = this.unlock();
        const to = Math.min(
            this.start + this.originalLength,
            this.editor.state.doc.content.size,
        );
        const chain = editable ? this.editor.chain().focus() : this.editor.chain();
        chain.setTextSelection({from: this.start, to}).run();
        this.finish();
    }

    /** Hands the editable flag back to whatever the article wants it to be by now. */
    private unlock(): boolean {
        const editable = this.restoreEditable();
        this.editor.setEditable(editable, false);
        return editable;
    }

    private finish(): void {
        this.live = false;
        this.original = Slice.empty;
    }
}
