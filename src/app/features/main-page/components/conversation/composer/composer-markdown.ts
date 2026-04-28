/** A raw text run or an atomic mention chip from the contenteditable. */
export type EditorSegment = { type: 'text'; text: string } | { type: 'chip'; el: HTMLElement };

/**
 * Walk the editor DOM and extract alternating text runs and mention-chip elements.
 * All markdown span wrappers (<strong>, <em>, .md-mark, etc.) are flattened so
 * subsequent calls always operate on the raw markdown source text.
 */
export function getEditorSegments(editor: HTMLElement): EditorSegment[] {
  const segments: EditorSegment[] = [];
  let textAcc = '';

  function walk(node: Node): void {
    if (node instanceof HTMLElement && node.classList.contains('mention-chip')) {
      if (textAcc) { segments.push({ type: 'text', text: textAcc }); textAcc = ''; }
      segments.push({ type: 'chip', el: node.cloneNode(true) as HTMLElement });
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        textAcc += child.textContent ?? '';
      } else if (child instanceof HTMLElement && child.tagName === 'BR') {
        textAcc += '\n';
      } else {
        walk(child);
      }
    }
  }

  walk(editor);
  if (textAcc) segments.push({ type: 'text', text: textAcc });
  return segments;
}

/** Rebuild the editor DOM from segments with inline markdown syntax highlighted. */
export function buildHighlightedFragment(segments: EditorSegment[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    if (seg.type === 'chip') {
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
 * The input is HTML-escaped first — this function is XSS-safe.
 *
 * Single-pass regex tries the most specific patterns first (** before *) so
 * double-star bold is never misread as two italic markers.
 */
export function highlightInlineMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(
    /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|`([^`\n]+?)`|\*([^*\n]+?)\*|_([^_\n]+?)_/g,
    (_, b1, b2, s, c, i1, i2) => {
      if (b1 != null) return `<span class="md-mark">**</span><strong>${b1}</strong><span class="md-mark">**</span>`;
      if (b2 != null) return `<span class="md-mark">__</span><strong>${b2}</strong><span class="md-mark">__</span>`;
      if (s  != null) return `<span class="md-mark">~~</span><s>${s}</s><span class="md-mark">~~</span>`;
      if (c  != null) return `<span class="md-mark">\`</span><code>${c}</code><span class="md-mark">\`</span>`;
      if (i1 != null) return `<span class="md-mark">*</span><em>${i1}</em><span class="md-mark">*</span>`;
      if (i2 != null) return `<span class="md-mark">_</span><em>${i2}</em><span class="md-mark">_</span>`;
      return _;
    }
  );

  return html.replace(/\n/g, '<br>');
}

/** Count how many characters precede the cursor in the editor's text content. */
export function getTextCursorOffset(editor: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const { startContainer, startOffset } = sel.getRangeAt(0);
  let count = 0;

  function walk(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === startContainer) { count += startOffset; return true; }
      count += node.textContent?.length ?? 0;
      return false;
    }
    if (node instanceof HTMLElement) {
      if (node.tagName === 'BR') { count += 1; return false; }
      // Treat mention chips as atomic — cursor cannot go inside them.
      if (node.classList.contains('mention-chip')) {
        count += node.textContent?.length ?? 0;
        return false;
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
      if (node.classList.contains('mention-chip')) {
        remaining -= node.textContent?.length ?? 0;
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
