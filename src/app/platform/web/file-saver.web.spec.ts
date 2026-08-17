/**
 * The browser save adapter.
 *
 * <p>What is worth pinning is mostly what this adapter <b>cannot</b> do: it has no way to learn that a
 * user cancelled, so it must never answer false, and a caller must never be able to read "saved to
 * disk" out of its return value. The rest is the mechanics that make a download actually happen in
 * every engine - the anchor has to be in the document, and the object URL has to outlive the click.</p>
 */

import {WebFileSaver} from './file-saver.web';

interface Recorded {
    href: string;
    download: string;
    rel: string;
    /** Whether the anchor was in the document at the moment it was clicked. Firefox requires it. */
    connectedAtClick: boolean;
}

/** Watches what the adapter does to the DOM and to the object-URL registry. */
function watch() {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const clicked: Recorded[] = [];

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
        created.push(blob as Blob);
        return `blob:test/${created.length}`;
    });
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => {
        revoked.push(url);
    });

    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const element = realCreate(tag as 'a');
        if (tag === 'a') {
            const anchor = element as HTMLAnchorElement;
            anchor.click = () =>
                clicked.push({
                    href: anchor.getAttribute('href') ?? '',
                    download: anchor.download,
                    rel: anchor.rel,
                    connectedAtClick: anchor.isConnected,
                });
        }
        return element;
    });

    return {created, revoked, clicked, createObjectURL, revokeObjectURL};
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('WebFileSaver', () => {
    it('clicks a download anchor for the bytes, then releases the object URL', async () => {
        vi.useFakeTimers();
        const dom = watch();

        expect(
            await new WebFileSaver().save('export.zip', new Uint8Array([1, 2, 3]), 'application/zip'),
        ).toBe(true);

        expect(dom.clicked).toHaveLength(1);
        expect(dom.clicked[0].download).toBe('export.zip');
        expect(dom.clicked[0].href).toBe('blob:test/1');
        // Reverse tabnabbing is not a risk for a download, but the intent stays legible next to the
        // link adapter, where it is the whole point.
        expect(dom.clicked[0].rel).toBe('noopener');

        // The URL must still resolve while the click is being processed.
        expect(dom.revoked).toEqual([]);
        vi.runAllTimers();
        expect(dom.revoked).toEqual(['blob:test/1']);
    });

    /** Firefox ignores a click on an anchor that is not in the document, and leaves no trace. */
    it('has the anchor in the document when it clicks it, and removes it after', async () => {
        const dom = watch();

        await new WebFileSaver().save('export.zip', new Uint8Array([1]));

        expect(dom.clicked[0].connectedAtClick).toBe(true);
        expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    });

    it("stamps the caller's MIME type on the blob", async () => {
        const dom = watch();

        await new WebFileSaver().save('theme.json', '{}', 'application/json');

        expect(dom.created[0].type).toBe('application/json');
    });

    /**
     * The two defaults differ by payload kind on purpose. A `Blob` does not assume UTF-8 for text, and
     * an unlabelled binary payload that a browser might sniff as HTML would be a stored-XSS vector on
     * this origin.
     */
    it('defaults text to UTF-8 and bytes to an opaque type', async () => {
        const dom = watch();
        const saver = new WebFileSaver();

        await saver.save('notes.txt', 'hello');
        await saver.save('blob.bin', new Uint8Array([1]));

        expect(dom.created[0].type).toBe('text/plain;charset=utf-8');
        expect(dom.created[1].type).toBe('application/octet-stream');
    });

    /**
     * The contract, stated as a test because it is the thing most likely to be misread: false means
     * *known* cancellation, a browser reports none, so this adapter can only ever answer true. Any UI
     * that words this as "Saved" is claiming more than the host knows.
     */
    it('always reports true, because a browser cannot report cancellation', async () => {
        watch();
        const saver = new WebFileSaver();

        expect(await saver.save('a.zip', new Uint8Array([1]))).toBe(true);
        expect(await saver.save('b.txt', 'text')).toBe(true);
    });

    /**
     * `saveLazy` produces first here, which is the opposite of the desktop adapter and is the honest
     * answer rather than a shortcut: `<a download>` is the destination decision and the write in one act
     * and needs bytes to point at, and there is no cancellation signal that deferring could wait for.
     * Pinned so the asymmetry is a documented property of this host and not something to "fix".
     */
    it('produces the bytes first and downloads them', async () => {
        const dom = watch();
        const produce = vi.fn(async () => new TextEncoder().encode('expensive'));

        expect(await new WebFileSaver().saveLazy('export.zip', produce, 'application/zip')).toBe(true);

        expect(produce).toHaveBeenCalledTimes(1);
        expect(dom.clicked).toHaveLength(1);
        expect(dom.clicked[0].download).toBe('export.zip');
        expect(dom.created[0].type).toBe('application/zip');
        expect(await dom.created[0].text()).toBe('expensive');
    });

    /** A producer that fails must not leave a half-made download or a leaked object URL behind. */
    it('offers nothing when the producer fails', async () => {
        const dom = watch();

        await expect(
            new WebFileSaver().saveLazy('export.zip', () => Promise.reject(new Error('nope'))),
        ).rejects.toThrow('nope');

        expect(dom.clicked).toEqual([]);
        expect(dom.createObjectURL).not.toHaveBeenCalled();
    });
});
