import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {save} from '@tauri-apps/plugin-dialog';
import {writeFile} from '@tauri-apps/plugin-fs';
import {FileService} from './file.service';

/** What an attachment needs to be saved: the id to fetch, and the name to offer. */
export interface DownloadableAttachment {
    id: string;
    fileName: string;
}

/**
 * Saving a chat attachment to a file the user chooses.
 *
 * <p>The old path built an object URL and clicked a synthetic `<a download>`. In a browser that
 * hands the file to the download manager; inside the webview there is no download manager, so it
 * produced no dialog, no destination and - as far as the user could tell - nothing at all. The
 * shell's own save dialog is what puts the choice back.</p>
 */
@Injectable({providedIn: 'root'})
export class AttachmentDownloadService {
    private readonly files = inject(FileService);

    /**
     * Asks where to put the file, then writes it there.
     *
     * <p>Returns `false` when the dialog was dismissed. The destination is chosen <em>before</em>
     * the bytes are fetched, so backing out of the dialog does not cost the user a download they
     * then throw away.</p>
     */
    async save(attachment: DownloadableAttachment): Promise<boolean> {
        const dest = await save({
            defaultPath: attachment.fileName,
            filters: filtersFor(attachment.fileName),
        });
        if (dest === null) return false;

        const blob = await firstValueFrom(this.files.downloadAttachmentById(attachment.id));
        await writeFile(dest, new Uint8Array(await blob.arrayBuffer()));
        return true;
    }
}

/**
 * A single filter for the file's own extension, or none for a file that has none.
 *
 * <p>Windows appends the active filter's extension to a name typed without one, so this is what
 * stops "holiday" being saved as an extensionless file the shell can no longer open.</p>
 */
function filtersFor(fileName: string): {name: string; extensions: string[]}[] {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0 || dot === fileName.length - 1) return [];
    const extension = fileName.slice(dot + 1);
    return [{name: extension.toUpperCase(), extensions: [extension]}];
}
