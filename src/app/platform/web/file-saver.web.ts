import {FileSaver} from '../ports/file-saver.port';

/** What an unlabelled byte payload is called when the caller named no MIME type. */
const DEFAULT_BINARY_MIME = 'application/octet-stream';

/** Text without a stated type. UTF-8 is spelled out because a `Blob` does not assume it for text. */
const DEFAULT_TEXT_MIME = 'text/plain;charset=utf-8';

/**
 * The browser save path: wrap the bytes in a {@link Blob} and let the download manager have them.
 *
 * <p><b>This adapter can never return false.</b> That is not laziness, it is the honest reading of
 * the port: false means <i>known</i> cancellation, and a browser reports nothing at all about what
 * happens after the click. Whether the file landed in the downloads folder, opened a "Save as" dialog
 * the user then dismissed, was renamed to avoid a collision, or was blocked outright by a policy - all
 * of it is invisible to the page. So true here means "the browser accepted the download", which is the
 * strongest claim available, and callers must not present it as "saved to disk".</p>
 *
 * <p>The practical consequence for the UI: a success toast worded like "Saved" is a lie on web, and a
 * flow that asks "where would you like this?" cannot be honoured. Anything that needs the
 * destination, or needs to know the user backed out, needs a capability check first.</p>
 */
export class WebFileSaver extends FileSaver {
    override async save(suggestedName: string, data: Uint8Array | string, mime?: string): Promise<boolean> {
        return this.offer(suggestedName, data, mime);
    }

    /**
     * Produces the bytes <b>first</b>, then offers them - the reverse of the desktop adapter.
     *
     * <p><b>The ordering cannot be preserved here, and this is why.</b> `saveLazy` exists so a host can
     * put the question before the cost: ask where the file goes, and if the user backs out, never do the
     * expensive work. That requires a moment where a destination is known and nothing has been written -
     * a modal save dialog. A browser has no such moment. `<a download>` is the destination decision and
     * the write in one act, and it needs the bytes to point at; the download manager decides the path
     * afterwards, out of the page's reach.</p>
     *
     * <p>There is also nothing to protect: this host cannot report cancellation at all, so deferring the
     * work would buy an answer that never arrives. The honest shape is therefore eager, and callers get
     * the guarantee on the host that can keep it rather than nowhere.</p>
     */
    override async saveLazy(
        suggestedName: string,
        produce: () => Promise<Uint8Array>,
        mime?: string,
    ): Promise<boolean> {
        return this.offer(suggestedName, await produce(), mime);
    }

    private async offer(suggestedName: string, data: Uint8Array | string, mime?: string): Promise<boolean> {
        const type = mime ?? (typeof data === 'string' ? DEFAULT_TEXT_MIME : DEFAULT_BINARY_MIME);
        const blob = new Blob([asBlobPart(data)], {type});
        const url = URL.createObjectURL(blob);

        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            // The filename the browser offers. It is a suggestion on this host in a way it is not on
            // desktop: the download manager will rename around a collision and may sanitise it.
            anchor.download = suggestedName;
            // Belt and braces. A download navigation opens no window, so there is nothing to inherit
            // an opener - but this costs nothing and keeps the intent legible next to the other adapter.
            anchor.rel = 'noopener';
            // Firefox ignores a click on an anchor that is not in the document.
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } finally {
            // Revoking synchronously would race the click on some engines; one turn of the loop is
            // enough for the download to have taken its own reference to the blob.
            setTimeout(() => URL.revokeObjectURL(url), 0);
        }

        return true;
    }
}

/**
 * Narrows the port's payload to something {@link Blob} will accept.
 *
 * <p>A bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which admits a `SharedArrayBuffer`, and the
 * DOM's `BlobPart` requires a non-shared buffer. The assertion is the right tool rather than a copy:
 * every caller here builds its bytes from a `Blob`, a `TextEncoder` or the crypto engine, none of which
 * can produce a shared buffer, and `slice()`ing to satisfy the checker would duplicate an
 * account-sized archive in memory to change nothing at runtime.</p>
 */
function asBlobPart(data: Uint8Array | string): BlobPart {
    return typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>);
}
