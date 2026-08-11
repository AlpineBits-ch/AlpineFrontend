import {FileSaver} from '../ports/file-saver.port';

/**
 * The desktop save path: ask the shell for a destination, then write the bytes there.
 *
 * <p>Both plugins are {@code import()}ed on first save rather than at construction, so the browser
 * bundle never reaches them. The dialog module is loaded before the write module deliberately - if
 * the user dismisses the dialog, the filesystem plugin is never fetched at all.</p>
 */
export class TauriFileSaver extends FileSaver {
    /**
     * Returns false only when the dialog was dismissed.
     *
     * <p>A string is written through {@code writeTextFile} and bytes through {@code writeFile}. That
     * split is not cosmetic: {@code writeTextFile} encodes UTF-8, which is what the JSON callers
     * (theme export) want, while {@code writeFile} takes the buffer verbatim, which is what the
     * binary callers (attachments, export archives) need.</p>
     *
     * <p>{@code mime} is unused here. The shell decides how to treat a file from its extension, and
     * the extension is already in {@code suggestedName}; there is nowhere on this host to put a MIME
     * type. It exists in the port for the web adapter, which has to stamp it on the {@link Blob}.</p>
     */
    override async save(suggestedName: string, data: Uint8Array | string, mime?: string): Promise<boolean> {
        void mime;

        const dest = await askForDestination(suggestedName);
        if (dest === null) return false;

        const fs = await import('@tauri-apps/plugin-fs');
        if (typeof data === 'string') {
            await fs.writeTextFile(dest, data);
        } else {
            await fs.writeFile(dest, data);
        }
        return true;
    }

    /**
     * Asks first, and only produces the bytes once there is somewhere to put them.
     *
     * <p><b>This ordering is the whole point of the method.</b> A dismissed dialog returns false having
     * never called `produce`, so backing out costs the user nothing - which is what it cost before the
     * port existed, and what a save dialog in front of a multi-megabyte download has to keep costing.
     * The web adapter cannot honour it and says so; this host can, so it must.</p>
     */
    override async saveLazy(
        suggestedName: string,
        produce: () => Promise<Uint8Array>,
        mime?: string,
    ): Promise<boolean> {
        void mime;

        const dest = await askForDestination(suggestedName);
        if (dest === null) return false;

        const data = await produce();
        const {writeFile} = await import('@tauri-apps/plugin-fs');
        await writeFile(dest, data);
        return true;
    }
}

/** The save dialog, with a filter derived from the name. Null when it was dismissed. */
async function askForDestination(suggestedName: string): Promise<string | null> {
    const {save} = await import('@tauri-apps/plugin-dialog');
    return save({
        defaultPath: suggestedName,
        filters: filtersFor(suggestedName),
    });
}

/**
 * A single filter for the file's own extension, or none for a file that has none.
 *
 * <p>Windows appends the active filter's extension to a name typed without one, so this is what
 * stops "holiday" being saved as an extensionless file the shell can no longer open.</p>
 *
 * <p>Derived from the name rather than passed in, because {@link FileSaver.save} takes no filter
 * argument - and it should not: a caller that has already decided the filename has, by that act,
 * decided the file type. The visible cost is the filter's <i>label</i>, which is now the extension
 * in capitals ("JSON") instead of a prose name the call site used to supply ("Alpine Theme"). The
 * extension it enforces is identical.</p>
 */
function filtersFor(fileName: string): {name: string; extensions: string[]}[] {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0 || dot === fileName.length - 1) return [];
    const extension = fileName.slice(dot + 1);
    return [{name: extension.toUpperCase(), extensions: [extension]}];
}
