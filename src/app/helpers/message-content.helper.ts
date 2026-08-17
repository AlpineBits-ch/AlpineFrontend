/**
 * The one place a message body turns into text a human sees. Every render site must call in here,
 * so the `undecryptable` check cannot be missed on one of them.
 */

/** Shown in place of any body this device could not authenticate. */
export const UNDECRYPTABLE_PLACEHOLDER = '[This message could not be verified on this device]';

/** The short form, for previews and snippets where the full sentence does not fit. */
export const UNDECRYPTABLE_SHORT = '🔒 Unverified message';

/** The minimum a caller has to know about a message to render its body safely. */
export interface RenderableMessage {
    content: string;
    undecryptable?: boolean;
}

/**
 * Decodes a message body, or refuses to.
 *
 * @param fallback what to return when the body must not be shown. Defaults to the full sentence;
 *        pass {@link UNDECRYPTABLE_SHORT} in a one-line preview.
 */
export function readableContent(
    msg: RenderableMessage | null | undefined,
    fallback: string = UNDECRYPTABLE_PLACEHOLDER,
): string {
    if (!msg) return '';
    if (msg.undecryptable) return fallback;
    return decodeBody(msg.content);
}

/** Base64 to text. A body that is not valid base64 is returned as-is. */
export function decodeBody(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return encoded;
    }
}
