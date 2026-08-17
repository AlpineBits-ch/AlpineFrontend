/**
 * The desktop save adapter: a dialog, then a write.
 *
 * <p>Mocking `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` is legitimate <i>here</i> in a way
 * it was not in the services that used to do it. This file is the adapter: the plugins are the layer
 * below it, and there is nothing further down to fake. The extension-filter cases moved here from
 * `attachment-download.service.spec.ts` for the same reason - they describe a Windows save dialog, not
 * an attachment.</p>
 */

// vi.hoisted, because vi.mock is lifted above the imports and its factory therefore runs before any
// plain const in this file has been initialised.
const {save, writeFile, writeTextFile} = vi.hoisted(() => ({
    save: vi.fn(),
    writeFile: vi.fn(),
    writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({save: (options: unknown) => save(options)}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    writeFile: (path: string, data: Uint8Array) => writeFile(path, data),
    writeTextFile: (path: string, data: string) => writeTextFile(path, data),
}));

import {TauriFileSaver} from './file-saver.tauri';

function setup() {
    save.mockReset();
    writeFile.mockReset();
    writeTextFile.mockReset();
    writeFile.mockResolvedValue(undefined);
    writeTextFile.mockResolvedValue(undefined);
    return new TauriFileSaver();
}

describe('TauriFileSaver', () => {
    it('asks for a destination and writes the bytes there', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\Users\\someone\\Pictures\\holiday.png');

        expect(await saver.save('holiday.png', new TextEncoder().encode('bytes'), 'image/png')).toBe(true);

        expect(save).toHaveBeenCalledWith(expect.objectContaining({defaultPath: 'holiday.png'}));
        const [dest, data] = writeFile.mock.calls[0] as unknown as [string, Uint8Array];
        expect(dest).toBe('C:\\Users\\someone\\Pictures\\holiday.png');
        expect(new TextDecoder().decode(data)).toBe('bytes');
    });

    /**
     * A string goes through `writeTextFile`, which encodes UTF-8. Sending it through `writeFile`
     * instead would need a `TextEncoder` here and would write the theme JSON as whatever the caller
     * happened to encode.
     */
    it('writes a string payload as text', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\themes\\midnight.json');

        expect(await saver.save('midnight.json', '{"name":"Midnight"}', 'application/json')).toBe(true);

        expect(writeTextFile).toHaveBeenCalledWith('C:\\themes\\midnight.json', '{"name":"Midnight"}');
        expect(writeFile).not.toHaveBeenCalled();
    });

    /** False means the dialog was dismissed, and nothing may be written. */
    it('writes nothing when the dialog is dismissed', async () => {
        const saver = setup();
        save.mockResolvedValue(null);

        expect(await saver.save('holiday.png', new Uint8Array([1, 2, 3]))).toBe(false);

        expect(writeFile).not.toHaveBeenCalled();
        expect(writeTextFile).not.toHaveBeenCalled();
    });

    /** Windows appends the active filter's extension to a name typed without one. */
    it('offers a filter for the extension the name already has', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\notes.pdf');

        await saver.save('notes.pdf', new Uint8Array([1]));

        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({
                filters: [{name: 'PDF', extensions: ['pdf']}],
            }),
        );
    });

    it('offers no filter for a name without an extension', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\dump');

        await saver.save('dump', new Uint8Array([1]));

        expect(save).toHaveBeenCalledWith(expect.objectContaining({filters: []}));
    });

    /**
     * The guarantee `saveLazy` exists for: on this host the question comes before the cost, so a
     * dismissed dialog must leave the producer untouched. A caller passing a multi-megabyte download in
     * there is relying on exactly this.
     */
    it('never produces the bytes when the dialog is dismissed', async () => {
        const saver = setup();
        save.mockResolvedValue(null);
        const produce = vi.fn(async () => new TextEncoder().encode('expensive'));

        expect(await saver.saveLazy('holiday.png', produce)).toBe(false);

        expect(produce).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('produces the bytes once a destination is known, and writes them', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\holiday.png');
        const produce = vi.fn(async () => new TextEncoder().encode('expensive'));

        expect(await saver.saveLazy('holiday.png', produce)).toBe(true);

        expect(produce).toHaveBeenCalledTimes(1);
        const [dest, data] = writeFile.mock.calls[0] as unknown as [string, Uint8Array];
        expect(dest).toBe('C:\\holiday.png');
        expect(new TextDecoder().decode(data)).toBe('expensive');
    });

    /** The dialog is answered first, so its filter still comes from the name rather than the payload. */
    it("offers the name's filter before producing anything", async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\notes.pdf');

        await saver.saveLazy('notes.pdf', async () => new Uint8Array([1]));

        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({
                filters: [{name: 'PDF', extensions: ['pdf']}],
            }),
        );
    });

    /** A producer that fails takes the save down with it, rather than writing an empty file. */
    it('propagates a failure from the producer without writing', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\holiday.png');

        await expect(
            saver.saveLazy('holiday.png', () => Promise.reject(new Error('fetch failed'))),
        ).rejects.toThrow('fetch failed');

        expect(writeFile).not.toHaveBeenCalled();
    });

    /** A dotfile has no extension, and a trailing dot is not one either. */
    it('offers no filter for a dotfile or a trailing dot', async () => {
        const saver = setup();
        save.mockResolvedValue('C:\\out');

        await saver.save('.gitignore', new Uint8Array([1]));
        await saver.save('archive.', new Uint8Array([1]));

        expect(save).toHaveBeenNthCalledWith(1, expect.objectContaining({filters: []}));
        expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({filters: []}));
    });
});
