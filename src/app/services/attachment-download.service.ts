import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {PlatformHost} from '../platform/host';
import {FileSaver} from '../platform/ports/file-saver.port';
import {FileService} from './file.service';

/** What an attachment needs to be saved: the id to fetch, and the name to offer. */
export interface DownloadableAttachment {
    id: string;
    fileName: string;
}

/** Web has no cancellation signal, so a completed save there can only claim "download started". */
export function attachmentSavedToastKey(host: PlatformHost): string {
    return host === 'web' ? 'MESSAGE.DOWNLOAD_STARTED' : 'MESSAGE.DOWNLOAD_SAVED';
}

/** Saving a chat attachment through {@link FileSaver}, so each host does its own right thing. */
@Injectable({providedIn: 'root'})
export class AttachmentDownloadService {
    private readonly files = inject(FileService);
    private readonly saver = inject(FileSaver);

    /** Asks where to put the file, then fetches it. `saveLazy`, not `save`: the destination is chosen first. */
    async save(attachment: DownloadableAttachment): Promise<boolean> {
        return this.saver.saveLazy(attachment.fileName, async () => {
            const blob = await firstValueFrom(this.files.downloadAttachmentById(attachment.id));
            return new Uint8Array(await blob.arrayBuffer());
        });
    }
}
