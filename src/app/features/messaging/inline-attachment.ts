/**
 * An attachment placed in the body rather than in the gallery under it. The body carries a token,
 * never a URL: the ids in `attachments` are what the server already sends, so an inline picture
 * costs no new field and no new request.
 *
 * A client that does not know the token renders it as literal text. That is the whole cost of the
 * feature, and the reason the token is short and unmistakable rather than a markdown image.
 */
export const INLINE_ATTACHMENT_SOURCE = '<att:(atac_[A-Za-z0-9_-]{1,64})>';

export function inlineAttachmentPattern(): RegExp {
    return new RegExp(INLINE_ATTACHMENT_SOURCE, 'g');
}

export function inlineAttachmentToken(attachmentId: string): string {
    return `<att:${attachmentId}>`;
}

export function isAttachmentId(value: string | null | undefined): boolean {
    return !!value && /^atac_[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** Every attachment placed in a body, in the order they appear, without repeats. */
export function inlineAttachmentIds(content: string): string[] {
    const found = new Set<string>();
    for (const match of content.matchAll(inlineAttachmentPattern())) found.add(match[1]);
    return [...found];
}

/** Strips the tokens, for a preview or a snippet that has no way to draw the picture. */
export function stripInlineAttachments(content: string): string {
    return content.replace(inlineAttachmentPattern(), '');
}
