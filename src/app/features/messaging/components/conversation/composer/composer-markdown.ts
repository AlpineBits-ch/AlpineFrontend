import hljs from 'highlight.js';

/**
 * A node the editor treats as one character: the cursor goes before or after it, never inside.
 * An attachment chip counts as one regardless of the filename drawn in it, so two chips side by
 * side still occupy two cursor positions.
 */
export function isAtomicChip(node: Node): boolean {
    return node instanceof HTMLElement && node.classList.contains('attachment-chip');
}

/** A raw text run or an atomic mention chip from the contenteditable. */
export type EditorSegment =
    | {type: 'text'; text: string}
    | {type: 'chip'; el: HTMLElement}
    | {
          type: 'emoji';
          el: HTMLImageElement;
      };

/**
 * Walk the editor DOM and extract alternating text runs and mention-chip elements.
 * All markdown span wrappers (`<strong>`, `<em>`, .md-mark, etc.) are flattened so
 * subsequent calls always operate on the raw markdown source text.
 */
export function getEditorSegments(editor: HTMLElement): EditorSegment[] {
    const segments: EditorSegment[] = [];
    let textAcc = '';

    function walk(node: Node): void {
        if (node instanceof HTMLElement && (node.classList.contains('mention-chip') || isAtomicChip(node))) {
            if (textAcc) {
                segments.push({type: 'text', text: textAcc});
                textAcc = '';
            }
            segments.push({type: 'chip', el: node.cloneNode(true) as HTMLElement});
            return;
        }
        if (node instanceof HTMLImageElement && node.dataset['emoji']) {
            if (textAcc) {
                segments.push({type: 'text', text: textAcc});
                textAcc = '';
            }
            segments.push({type: 'emoji', el: node.cloneNode(true) as HTMLImageElement});
            return;
        }
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                textAcc += child.textContent ?? '';
            } else if (child instanceof HTMLElement && child.tagName === 'BR') {
                if (!child.dataset['sentinel']) textAcc += '\n';
            } else {
                walk(child);
            }
        }
    }

    walk(editor);
    if (textAcc) segments.push({type: 'text', text: textAcc});
    return segments;
}

/** Rebuild the editor DOM from segments with inline markdown syntax highlighted. */
export function buildHighlightedFragment(segments: EditorSegment[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const seg of segments) {
        if (seg.type === 'chip' || seg.type === 'emoji') {
            frag.appendChild(seg.el);
        } else {
            const tmp = document.createElement('span');
            tmp.innerHTML = highlightInlineMarkdown(seg.text);
            while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        }
    }
    return frag;
}

/**
 * Convert raw markdown text to highlighted HTML.
 * Handles fenced code blocks (``` ... ```) as block-level segments so their
 * contents are never mangled by the inline-pattern pass.
 * The input is HTML-escaped before any processing: this function is XSS-safe.
 */
export function highlightInlineMarkdown(text: string): string {
    const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
    const parts: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRe.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(applyInlineStyles(text.slice(lastIndex, match.index)));
        }
        const lang = match[1];
        const rawCode = match[2];
        const langSpan = lang ? `<span class="md-mark md-lang">${escapeHtml(lang)}</span>` : '';
        const codeHtml =
            lang && hljs.getLanguage(lang)
                ? hljs.highlight(rawCode, {language: lang}).value.replace(/\n/g, '<br>')
                : escapeHtml(rawCode).replace(/\n/g, '<br>');
        parts.push(
            `<span class="md-mark">\`\`\`</span>${langSpan}<br>` +
                `<code class="md-codeblock">${codeHtml}</code>` +
                `<span class="md-mark">\`\`\`</span>`,
        );
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex);
        const unterminatedRe = /```(\w*)(\n([\s\S]*))?/;
        const um = unterminatedRe.exec(remaining);
        if (um !== null) {
            if (um.index > 0) parts.push(applyInlineStyles(remaining.slice(0, um.index)));
            const lang = um[1];
            const hasNewline = um[2] !== undefined;
            const rawCode = um[3] ?? '';
            const langSpan = lang ? `<span class="md-mark md-lang">${escapeHtml(lang)}</span>` : '';
            if (hasNewline) {
                const codeHtml =
                    lang && hljs.getLanguage(lang)
                        ? hljs.highlight(rawCode, {language: lang}).value.replace(/\n/g, '<br>')
                        : escapeHtml(rawCode).replace(/\n/g, '<br>');
                parts.push(`<span class="md-mark">\`\`\`</span>${langSpan}<br>${codeHtml}`);
            } else {
                parts.push(`<span class="md-mark">\`\`\`</span>${langSpan}`);
                const afterMatch = remaining.slice(um.index + um[0].length);
                if (afterMatch) parts.push(applyInlineStyles(afterMatch));
            }
        } else {
            parts.push(applyInlineStyles(remaining));
        }
    }

    return parts.join('');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyInlineStyles(text: string): string {
    let html = escapeHtml(text);

    html = html.replace(
        /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|`([^`\n]+?)`|\*([^*\n]+?)\*|_([^_\n]+?)_|\*\*([^*\n]+)$|__([^_\n]+)$|~~([^~\n]+)$|`([^`\n]+)$/gm,
        (_, b1, b2, s, c, i1, i2, ub1, ub2, us, uc) => {
            if (b1 != null)
                return `<span class="md-mark">**</span><strong>${b1}</strong><span class="md-mark">**</span>`;
            if (b2 != null)
                return `<span class="md-mark">__</span><strong>${b2}</strong><span class="md-mark">__</span>`;
            if (s != null) return `<span class="md-mark">~~</span><s>${s}</s><span class="md-mark">~~</span>`;
            if (c != null)
                return `<span class="md-mark">\`</span><code>${c}</code><span class="md-mark">\`</span>`;
            if (i1 != null)
                return `<span class="md-mark">*</span><em>${i1}</em><span class="md-mark">*</span>`;
            if (i2 != null)
                return `<span class="md-mark">_</span><em>${i2}</em><span class="md-mark">_</span>`;
            if (ub1 != null) return `<span class="md-mark">**</span><strong>${ub1}</strong>`;
            if (ub2 != null) return `<span class="md-mark">__</span><strong>${ub2}</strong>`;
            if (us != null) return `<span class="md-mark">~~</span><s>${us}</s>`;
            if (uc != null) return `<span class="md-mark">\`</span><code>${uc}</code>`;
            return _;
        },
    );

    return html.replace(/\n/g, '<br>');
}

/** Count how many characters precede the cursor in the editor's text content. */
export function getTextCursorOffset(editor: HTMLElement): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const {startContainer, startOffset} = sel.getRangeAt(0);
    let count = 0;

    // Count all chars in a subtree unconditionally (no cursor detection).
    function countAll(node: Node): void {
        if (node.nodeType === Node.TEXT_NODE) {
            count += node.textContent?.length ?? 0;
            return;
        }
        if (node instanceof HTMLElement) {
            if (node.tagName === 'BR') {
                count += 1;
                return;
            }
            if (isAtomicChip(node)) {
                count += 1;
                return;
            }
            if (node.classList.contains('mention-chip')) {
                count += node.textContent?.length ?? 0;
                return;
            }
            if (node.tagName === 'IMG' && node.dataset['emoji']) {
                count += 1;
                return;
            }
            for (const child of Array.from(node.childNodes)) countAll(child);
        }
    }

    function walk(node: Node): boolean {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node === startContainer) {
                count += startOffset;
                return true;
            }
            count += node.textContent?.length ?? 0;
            return false;
        }
        if (node instanceof HTMLElement) {
            if (node.tagName === 'BR') {
                count += 1;
                return false;
            }
            if (isAtomicChip(node)) {
                if (node === startContainer) return true;
                count += 1;
                return false;
            }
            if (node.classList.contains('mention-chip')) {
                count += node.textContent?.length ?? 0;
                return false;
            }
            if (node.tagName === 'IMG' && node.dataset['emoji']) {
                if (node === startContainer) {
                    return true;
                }
                count += 1;
                return false;
            }
            if (node === startContainer) {
                // Cursor is at child index startOffset inside this element node
                // (e.g. after setStartAfter(`<br>`), startContainer becomes the parent element).
                for (let i = 0; i < startOffset && i < node.childNodes.length; i++) {
                    countAll(node.childNodes[i]);
                }
                return true;
            }
        }
        for (const child of Array.from(node.childNodes)) {
            if (walk(child)) return true;
        }
        return false;
    }

    walk(editor);
    return count;
}

/** Place the cursor at the given character offset after a DOM rebuild. */
export function restoreCursorOffset(editor: HTMLElement, target: number): void {
    let remaining = target;

    function walk(node: Node): boolean {
        if (node.nodeType === Node.TEXT_NODE) {
            const len = node.textContent?.length ?? 0;
            if (remaining <= len) {
                const r = document.createRange();
                r.setStart(node as Text, remaining);
                r.collapse(true);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(r);
                return true;
            }
            remaining -= len;
            return false;
        }
        if (node instanceof HTMLElement) {
            if (node.tagName === 'BR') {
                if (remaining <= 0) {
                    const r = document.createRange();
                    r.setStartBefore(node);
                    r.collapse(true);
                    window.getSelection()?.removeAllRanges();
                    window.getSelection()?.addRange(r);
                    return true;
                }
                remaining -= 1;
                return false;
            }
            if (isAtomicChip(node)) {
                if (remaining <= 0) {
                    const r = document.createRange();
                    r.setStartBefore(node);
                    r.collapse(true);
                    window.getSelection()?.removeAllRanges();
                    window.getSelection()?.addRange(r);
                    return true;
                }
                remaining -= 1;
                return false;
            }
            if (node.classList.contains('mention-chip')) {
                remaining -= node.textContent?.length ?? 0;
                return false;
            }
            if (node.tagName === 'IMG' && node.dataset['emoji']) {
                if (remaining <= 0) {
                    const r = document.createRange();
                    r.setStartBefore(node);
                    r.collapse(true);
                    window.getSelection()?.removeAllRanges();
                    window.getSelection()?.addRange(r);
                    return true;
                }
                remaining -= 1;
                return false;
            }
        }
        for (const child of Array.from(node.childNodes)) {
            if (walk(child)) return true;
        }
        return false;
    }

    if (!walk(editor)) {
        // Fallback: end of editor.
        const r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
    }
}

// ── Blocks ───────────────────────────────────────────────────────────────────

/**
 * Editor content is split into blocks so a keystroke re-highlights one paragraph instead of the
 * whole post. A block is a span, never a div: the editor is `white-space: pre-wrap` and a block-level
 * box would draw a line break on top of the `<br>` the source newline already became.
 */
export const BLOCK_TAG = 'span';
export const BLOCK_ATTR = 'data-block';
const BLOCK_SELECTOR = `[${BLOCK_ATTR}]`;

/** Half-open `[start, end)` ranges of the text covered by fences, including an unterminated one. */
function fenceRegions(text: string): [number, number][] {
    const regions: [number, number][] = [];
    const re = /```/g;
    let open: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (open === null) {
            open = m.index;
        } else {
            regions.push([open, m.index + 3]);
            open = null;
        }
    }
    if (open !== null) regions.push([open, text.length]);
    return regions;
}

function insideFence(regions: [number, number][], index: number): boolean {
    return regions.some(([start, end]) => index >= start && index < end);
}

/**
 * Cut text at blank lines that are not inside a fence. Each piece keeps its own trailing newlines,
 * so joining the result reproduces the input exactly.
 */
export function splitIntoBlocks(text: string): string[] {
    if (!text) return [''];

    const fences = fenceRegions(text);
    const blocks: string[] = [];
    let start = 0;
    let i = 0;

    while (i < text.length) {
        if (text[i] === '\n' && text[i + 1] === '\n' && !insideFence(fences, i)) {
            let end = i + 2;
            while (text[end] === '\n') end++;
            blocks.push(text.slice(start, end));
            start = end;
            i = end;
            continue;
        }
        i++;
    }

    if (start < text.length) blocks.push(text.slice(start));
    return blocks.length ? blocks : [''];
}

/**
 * Identifies a block's source for the dirty check. Node positions matter as much as the text: a chip
 * moving between two identical runs has to count as a change.
 */
export function blockKey(segments: EditorSegment[]): string {
    return segments.map(s => (s.type === 'text' ? s.text : '\u0000')).join('\u0001');
}

/** The block a node sits in, or null if the editor has not been blocked yet. */
export function blockOf(node: Node | null, editor: HTMLElement): HTMLElement | null {
    let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    while (el && el !== editor) {
        if (el.hasAttribute(BLOCK_ATTR)) return el;
        el = el.parentElement;
    }
    return null;
}

export function blocksOf(editor: HTMLElement): HTMLElement[] {
    return Array.from(editor.querySelectorAll<HTMLElement>(`:scope > ${BLOCK_SELECTOR}`));
}

/** True when the editor's children are not the flat run of blocks the incremental path assumes. */
export function needsReblock(editor: HTMLElement): boolean {
    for (const child of Array.from(editor.childNodes)) {
        if (child instanceof HTMLElement && child.hasAttribute(BLOCK_ATTR)) continue;
        if (child instanceof HTMLElement && child.dataset['sentinel']) continue;
        return true;
    }
    return editor.childNodes.length === 0 ? false : blocksOf(editor).length === 0;
}

function makeBlock(): HTMLElement {
    const block = document.createElement(BLOCK_TAG);
    block.setAttribute(BLOCK_ATTR, '');
    return block;
}

/** Highlight one block's segments in place, leaving every other block's DOM untouched. */
export function highlightBlock(block: HTMLElement, segments: EditorSegment[]): void {
    block.replaceChildren(buildHighlightedFragment(segments));
}

/**
 * Rebuild the whole editor as highlighted blocks. The expensive path: used on paste, draft restore,
 * and whenever an edit changes where the block boundaries fall.
 */
export function renderBlocks(editor: HTMLElement, segments: EditorSegment[]): HTMLElement[] {
    const textOnly = segments.map(s => (s.type === 'text' ? s.text : '')).join('');
    const boundaries: number[] = [];
    let at = 0;
    for (const piece of splitIntoBlocks(textOnly)) {
        at += piece.length;
        boundaries.push(at);
    }

    const perBlock: EditorSegment[][] = boundaries.map(() => []);
    let blockIndex = 0;
    let offset = 0;

    for (const seg of segments) {
        if (seg.type !== 'text') {
            // A chip carries no newline, so it can never open a block. It belongs to whichever block
            // the cursor position it sits at falls in.
            while (blockIndex < boundaries.length - 1 && offset >= boundaries[blockIndex]) blockIndex++;
            perBlock[blockIndex].push(seg);
            continue;
        }

        let text = seg.text;
        while (text.length > 0) {
            while (blockIndex < boundaries.length - 1 && offset >= boundaries[blockIndex]) blockIndex++;
            const room = boundaries[blockIndex] - offset;
            const take = Math.min(room, text.length);
            perBlock[blockIndex].push({type: 'text', text: text.slice(0, take)});
            text = text.slice(take);
            offset += take;
        }
    }

    const blocks = perBlock.map(blockSegments => {
        const block = makeBlock();
        highlightBlock(block, blockSegments);
        return block;
    });

    editor.replaceChildren(...blocks);
    applyTrailingSentinel(editor);
    return blocks;
}

/**
 * True when the editor holds no message at all. A `<br>` does not count as content: the browser
 * leaves one behind on its own when the last character is deleted.
 */
export function isEditorBlank(editor: HTMLElement): boolean {
    if ((editor.textContent ?? '') !== '') return false;
    return !editor.querySelector('img[data-emoji], .mention-chip, .attachment-chip');
}

/**
 * Browsers do not render a trailing `<br>` as a visible line unless something follows it, so the
 * cursor cannot land on the empty line after Shift+Enter without this.
 */
export function applyTrailingSentinel(editor: HTMLElement): void {
    for (const stale of Array.from(editor.querySelectorAll<HTMLElement>('br[data-sentinel]'))) {
        stale.remove();
    }
    if (!(editor.textContent ?? '').length && !editor.querySelector('br')) return;

    const blocks = blocksOf(editor);
    const last = blocks[blocks.length - 1] ?? editor;
    const lastNode = last.lastChild;
    if (lastNode instanceof HTMLElement && lastNode.tagName === 'BR') {
        const sentinel = document.createElement('br');
        sentinel.dataset['sentinel'] = '1';
        last.appendChild(sentinel);
    }
}
