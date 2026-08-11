import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {FileSaver} from '../platform/ports/file-saver.port';
import {FileService} from './file.service';

/** What an attachment needs to be saved: the id to fetch, and the name to offer. */
export interface DownloadableAttachment {
    id: string;
    fileName: string;
}

/**
 * Saving a chat attachment to a file the user chooses.
 *
 * <p>The original path built an object URL and clicked a synthetic `<a download>` unconditionally. In
 * a browser that hands the file to the download manager; inside the webview there is no download
 * manager, so it produced no dialog, no destination and - as far as the user could tell - nothing at
 * all. {@link FileSaver} is what makes each host do its own right thing: a save dialog and a write on
 * desktop, the download manager on web.</p>
 */
@Injectable({providedIn: 'root'})
export class AttachmentDownloadService {
    private readonly files = inject(FileService);
    private readonly saver = inject(FileSaver);

    /**
     * Asks where to put the file, then fetches it.
     *
     * <p>Returns false only when a desktop save dialog was dismissed. <b>A browser cannot report
     * cancellation at all, so on web this resolves true once the download has been handed over</b> -
     * see {@link FileSaver}.</p>
     *
     * <p>{@link FileSaver.saveLazy} rather than `save`, so <b>the destination is chosen before the bytes
     * are fetched</b> and backing out of the dialog does not cost the user a download they then throw
     * away. On a host with a real dialog the fetch below never runs if the user cancels; on web there is
     * no such moment and it runs first, which that adapter documents. That asymmetry is the reason this
     * is `saveLazy` and not a fetch followed by a `save`.</p>
     *
     * <p>No MIME type is declared, and it is not an oversight: the server's content type is only known
     * once the response arrives, which is inside the producer and therefore after `saveLazy`'s arguments
     * are fixed. The hosts' defaults are the right answer anyway - the desktop shell reads the type from
     * the extension, and on web an opaque type is what stops a browser sniffing a saved file as
     * something it can render.</p>
     */
    async save(attachment: DownloadableAttachment): Promise<boolean> {
        return this.saver.saveLazy(attachment.fileName, async () => {
            const blob = await firstValueFrom(this.files.downloadAttachmentById(attachment.id));
            return new Uint8Array(await blob.arrayBuffer());
        });
    }
}
