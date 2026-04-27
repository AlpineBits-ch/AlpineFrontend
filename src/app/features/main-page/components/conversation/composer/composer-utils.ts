/** Extract the plain-text message from a contenteditable element,
 *  converting mention-chip spans to their @Username#hash display value. */
export function getMessage(editor: HTMLElement): string {
  let text = '';

  const walk = (nodes: NodeList) => {
    nodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? '';
      } else if (node instanceof HTMLElement) {
        if (node.classList.contains('mention-chip')) {
          text += node.dataset['display'] ?? node.textContent ?? '';
        } else if (node.tagName === 'BR') {
          text += '\n';
        } else if (node.tagName === 'DIV') {
          text += '\n';
          walk(node.childNodes);
        } else {
          walk(node.childNodes);
        }
      }
    });
  };

  walk(editor.childNodes);
  return text.replace(/\u00a0/g, ' ').trim();
}

export type TriggerDetection =
  | { type: 'mention'; query: string; range: Range }
  | { type: 'command'; query: string; range: Range }
  | null;

/** Inspect the current selection to detect an active @ mention or / command trigger. */
export function detectTrigger(editor: HTMLElement): TriggerDetection {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const textBefore = (node.textContent ?? '').slice(0, range.startOffset);

  const mentionMatch = textBefore.match(/(?:^|[\s\u00a0])@(\w*)$/);
  if (mentionMatch) {
    const atPos = textBefore.lastIndexOf('@');
    const r = document.createRange();
    r.setStart(node as Text, atPos);
    r.setEnd(node as Text, range.startOffset);
    return { type: 'mention', query: mentionMatch[1], range: r };
  }

  const editorText = editor.textContent ?? '';
  const commandMatch = editorText.match(/^\/(\w*)$/);
  if (commandMatch) {
    const r = document.createRange();
    r.setStart(node as Text, 0);
    r.setEnd(node as Text, range.startOffset);
    return { type: 'command', query: commandMatch[1], range: r };
  }

  return null;
}
