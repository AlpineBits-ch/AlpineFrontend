import {ProfileFont} from '../../../../../dtos/response/profile.dto';
import {inlineAttachmentToken} from '../../../inline-attachment';

/**
 * The source text of an element, untrimmed, so a block's text can be cached and the blocks joined
 * back into the whole post. Mention chips read as their @Username display value.
 */
export function readEditorText(root: HTMLElement): string {
    let text = '';

    const walk = (nodes: NodeList) => {
        nodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent ?? '';
            } else if (node instanceof HTMLElement) {
                if (node.classList.contains('attachment-chip')) {
                    const id = node.dataset['attachmentId'];
                    if (id) text += inlineAttachmentToken(id);
                } else if (node.classList.contains('mention-chip')) {
                    text += node.dataset['display'] ?? node.textContent ?? '';
                } else if (node.tagName === 'IMG' && node.dataset['emoji']) {
                    text += node.dataset['emoji'];
                } else if (node.tagName === 'BR') {
                    if (!node.dataset['sentinel']) text += '\n';
                } else if (node.tagName === 'DIV') {
                    text += '\n';
                    walk(node.childNodes);
                } else {
                    walk(node.childNodes);
                }
            }
        });
    };

    walk(root.childNodes);
    return text;
}

/** Extract the plain-text message from a contenteditable element, ready to send. */
export function getMessage(editor: HTMLElement): string {
    return readEditorText(editor)
        .replace(/\u00a0/g, ' ')
        .trim();
}

/**
 * Puts plain text back into the editor, as far as {@link getMessage} can be inverted. Mention chips
 * and emoji images are not rebuilt: a restored draft carries the text somebody typed, and
 * re-resolving `@name` here would attach an id nobody picked.
 */
export function setEditorText(editor: HTMLElement, text: string): void {
    editor.innerHTML = '';
    text.split('\n').forEach((line, index) => {
        if (index > 0) editor.appendChild(document.createElement('br'));
        if (line) editor.appendChild(document.createTextNode(line));
    });
}

export type {EmojiSuggestion} from '../../../../../services/emoji-data.service';

export interface UserMentionCandidate {
    kind: 'user';
    userId: string;
    userName: string;
    avatarUrl?: string;
    accentColor?: string | null;
    font?: ProfileFont;
}

export interface RoleMentionCandidate {
    kind: 'role';
    roleId: string;
    name: string;
    color: string;
}

/** A character. Carries no owner, because a character mention never names one. */
export interface PersonaMentionCandidate {
    kind: 'persona';
    personaId: string;
    name: string;
    avatarUrl: string | null;
    color: string | null;
    tag: string | null;
}

export interface EveryoneMentionCandidate {
    kind: 'everyone';
}

export interface HereMentionCandidate {
    kind: 'here';
}

export type MentionCandidate =
    | UserMentionCandidate
    | PersonaMentionCandidate
    | RoleMentionCandidate
    | EveryoneMentionCandidate
    | HereMentionCandidate;

export function mentionCandidateId(c: MentionCandidate): string {
    switch (c.kind) {
        case 'user':
            return `user:${c.userId}`;
        case 'persona':
            return `persona:${c.personaId}`;
        case 'role':
            return `role:${c.roleId}`;
        case 'everyone':
            return 'everyone';
        case 'here':
            return 'here';
    }
}

export function mentionCandidateLabel(c: MentionCandidate): string {
    switch (c.kind) {
        case 'user':
            return c.userName;
        case 'persona':
            return c.name;
        case 'role':
            return c.name;
        case 'everyone':
            return 'everyone';
        case 'here':
            return 'here';
    }
}

export function mentionCandidateMatches(c: MentionCandidate, query: string): boolean {
    return mentionCandidateLabel(c).toLowerCase().includes(query.toLowerCase());
}

export type TriggerDetection =
    | {type: 'mention'; query: string; range: Range}
    | {type: 'command'; query: string; range: Range; atStart: boolean}
    | {type: 'emoji'; query: string; range: Range}
    | {type: 'channel'; query: string; range: Range}
    | {type: 'wiki'; query: string; range: Range}
    | null;

/** Inspect the current selection to detect an active @ mention, / command, or : emoji trigger. */
export function detectTrigger(editor: HTMLElement): TriggerDetection {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;

    const textBefore = (node.textContent ?? '').slice(0, range.startOffset);

    // `[[` for a wiki page, which is what `[[` already means inside the wiki editor itself. Tested
    // before the single-character triggers because a page title may contain any of them - `[[a:b`
    // is a page query, not an emoji shortcode - and the two-character opener cannot be reached by
    // accident the way a bare colon can.
    const wikiMatch = textBefore.match(/\[\[([^\[\]\n]{0,64})$/);
    if (wikiMatch) {
        const openPos = textBefore.lastIndexOf('[[');
        const r = document.createRange();
        r.setStart(node as Text, openPos);
        r.setEnd(node as Text, range.startOffset);
        return {type: 'wiki', query: wikiMatch[1], range: r};
    }

    const mentionMatch = textBefore.match(/(?:^|[\s\u00a0])@(\w*)$/);
    if (mentionMatch) {
        const atPos = textBefore.lastIndexOf('@');
        const r = document.createRange();
        r.setStart(node as Text, atPos);
        r.setEnd(node as Text, range.startOffset);
        return {type: 'mention', query: mentionMatch[1], range: r};
    }

    const channelMatch = textBefore.match(/(?:^|[\s ])#([\w-]*)$/);
    if (channelMatch) {
        const hashPos = textBefore.lastIndexOf('#');
        const r = document.createRange();
        r.setStart(node as Text, hashPos);
        r.setEnd(node as Text, range.startOffset);
        return {type: 'channel', query: channelMatch[1], range: r};
    }

    const commandMatch = textBefore.match(/(?:^|[\s\u00a0])\/(\w*)$/);
    if (commandMatch) {
        const slashPos = textBefore.lastIndexOf('/');
        const r = document.createRange();
        r.setStart(node as Text, slashPos);
        r.setEnd(node as Text, range.startOffset);
        // atStart = the entire editor content is just /word (no other text)
        const fullText = (editor.textContent ?? '').replace(/\u00a0/g, ' ').trim();
        const atStart = /^\/\w*$/.test(fullText);
        return {type: 'command', query: commandMatch[1], range: r, atStart};
    }

    // Emoji shortcode: :word or :flag-xx (at least 1 char after colon, hyphens allowed)
    const emojiMatch = textBefore.match(/(?:^|[^\w]):([\w-]{1,32})$/);
    if (emojiMatch) {
        const colonPos = textBefore.lastIndexOf(':');
        const r = document.createRange();
        r.setStart(node as Text, colonPos);
        r.setEnd(node as Text, range.startOffset);
        return {type: 'emoji', query: emojiMatch[1], range: r};
    }

    return null;
}
