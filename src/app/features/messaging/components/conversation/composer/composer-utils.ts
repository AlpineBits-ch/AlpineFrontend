import {ProfileFont} from '../../../../../dtos/response/profile.dto';

/** Extract the plain-text message from a contenteditable element,
 *  converting mention-chip spans to their @Username display value. */
export function getMessage(editor: HTMLElement): string {
    let text = '';

    const walk = (nodes: NodeList) => {
        nodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent ?? '';
            } else if (node instanceof HTMLElement) {
                if (node.classList.contains('mention-chip')) {
                    text += node.dataset['display'] ?? node.textContent ?? '';
                } else if (node.tagName === 'IMG' && node.dataset['emoji']) {
                    text += node.dataset['emoji'];
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

export interface EveryoneMentionCandidate {
    kind: 'everyone';
}

export interface HereMentionCandidate {
    kind: 'here';
}

export type MentionCandidate = UserMentionCandidate | RoleMentionCandidate | EveryoneMentionCandidate | HereMentionCandidate;

export function mentionCandidateId(c: MentionCandidate): string {
    switch (c.kind) {
        case 'user': return `user:${c.userId}`;
        case 'role': return `role:${c.roleId}`;
        case 'everyone': return 'everyone';
        case 'here': return 'here';
    }
}

export function mentionCandidateLabel(c: MentionCandidate): string {
    switch (c.kind) {
        case 'user': return c.userName;
        case 'role': return c.name;
        case 'everyone': return 'everyone';
        case 'here': return 'here';
    }
}

export function mentionCandidateMatches(c: MentionCandidate, query: string): boolean {
    return mentionCandidateLabel(c).toLowerCase().includes(query.toLowerCase());
}

export type TriggerDetection =
    | { type: 'mention'; query: string; range: Range }
    | { type: 'command'; query: string; range: Range; atStart: boolean }
    | { type: 'emoji'; query: string; range: Range }
    | { type: 'channel'; query: string; range: Range }
    | null;

/** Inspect the current selection to detect an active @ mention, / command, or : emoji trigger. */
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
