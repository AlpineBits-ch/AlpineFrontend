/**
 * The one place a message body turns into text a human sees.
 *
 * <p><b>`undecryptable` had no consumer anywhere.</b> It was set by three read paths - a failed
 * decrypt, a context this device was never admitted to, and (since §L.9) a message the server
 * declares cleartext inside a context this device has encrypted - and read by nothing, so every
 * one of those bodies was decoded and rendered anyway. For a failed decrypt that meant base64 at
 * the reader, which is how an unreadable conversation looked like a working one. For a
 * server-labelled `Plain` message it meant the injected text itself, under a real member's name.</p>
 *
 * <p>Suppressing it in the message bubble alone was not enough: the same `content` is decoded in
 * the sidebar preview, both search-result lists, the pinned panel, the reply chip above the
 * composer and the notification body. A flag checked in one of seven places is a flag that does not
 * work, so the check lives here and every site calls in.</p>
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

/**
 * Base64 to text, tolerantly.
 *
 * A body that is not valid base64 is returned as-is: some paths carry already-decoded text, and
 * throwing here would blank a message that is perfectly readable.
 */
export function decodeBody(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return encoded;
    }
}
