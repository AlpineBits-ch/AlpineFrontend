import {computed, inject, Injectable, OnDestroy, signal} from '@angular/core';
import {uploadFailureKey} from '../../../../../core/entitlement-message';
import {FileService} from '../../../../../services/file.service';

export interface AttachedFile {
    /** Absent on a file adopted from a draft: that one was uploaded by an earlier session. */
    file?: File;
    previewUrl: string;
    name: string;
    isImage: boolean;
    uploadedId?: string;
    isUploading: boolean;
    uploadFailed: boolean;
    /** Why it failed, as a translation key. Present only on a failure. */
    errorKey?: string;
}

/** Only a blob URL was minted here; a restored file points at the server and must not be revoked. */
function releasePreview(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

@Injectable()
export class ComposerAttachmentsService implements OnDestroy {
    readonly files = signal<AttachedFile[]>([]);
    readonly isDraggingOver = signal(false);
    /**
     * The biggest file the server would take here, in bytes, or null when nothing caps it. Set by
     * the host, which is what knows the scope: `storage.upload_max_bytes` inside a guild,
     * `user.upload_max_bytes` outside one.
     */
    readonly uploadCeiling = signal<number | null>(null);
    /** True while at least one attachment has no id yet, so a send now would go without it. */
    readonly isUploading = computed(() => this.files().some(f => f.isUploading));
    /** True once an upload has given up, so a send now would go without that file for good. */
    readonly hasFailed = computed(() => this.files().some(f => f.uploadFailed));
    /** The first failure's reason, for a caller that shows one sentence rather than one per file. */
    readonly failureKey = computed(() => this.files().find(f => f.uploadFailed)?.errorKey ?? null);
    /** Ids of the files that made it up. What a draft has to carry to survive a refresh. */
    readonly uploadedIds = computed(() =>
        this.files()
            .map(f => f.uploadedId)
            .filter((id): id is string => !!id),
    );
    private fileService = inject(FileService);
    private dragCounter = 0;
    /** Resolvers parked by {@link settled}, released together the moment nothing is in flight. */
    private settleWaiters: (() => void)[] = [];

    /** Queue a file, checking it against the server's ceiling before spending the transfer on it. */
    attach(file: File): void {
        const isImage = file.type.startsWith('image/');
        const previewUrl = URL.createObjectURL(file);

        const ceiling = this.uploadCeiling();
        if (ceiling !== null && file.size > ceiling) {
            this.files.update(prev => [
                ...prev,
                {
                    file,
                    previewUrl,
                    name: file.name,
                    isImage,
                    isUploading: false,
                    uploadFailed: true,
                    errorKey: 'COMPOSER.UPLOAD_TOO_LARGE',
                },
            ]);
            return;
        }

        const entry: AttachedFile = {
            file,
            previewUrl,
            name: file.name,
            isImage,
            isUploading: true,
            uploadFailed: false,
        };
        this.files.update(prev => [...prev, entry]);

        this.fileService.uploadFile(file).subscribe({
            next: response => {
                this.files.update(prev =>
                    prev.map(f => (f === entry ? {...f, uploadedId: response.id, isUploading: false} : f)),
                );
                this.releaseIfSettled();
            },
            error: (err: unknown) => {
                const errorKey = uploadFailureKey(err);
                this.files.update(prev =>
                    prev.map(f =>
                        f === entry ? {...f, isUploading: false, uploadFailed: true, errorKey} : f,
                    ),
                );
                this.releaseIfSettled();
            },
        });
    }

    /**
     * Put back the files a draft was saved with. They are already on the server, so nothing is
     * re-uploaded: only the metadata behind each id is read back so the tray can draw them.
     */
    adopt(ids: string[]): void {
        const known = new Set(this.files().map(f => f.uploadedId));
        for (const id of ids) {
            if (known.has(id)) continue;
            known.add(id);

            const entry: AttachedFile = {
                previewUrl: this.fileService.attachmentThumbnailUrl(id),
                name: '',
                isImage: false,
                uploadedId: id,
                isUploading: true,
                uploadFailed: false,
            };
            this.files.update(prev => [...prev, entry]);

            this.fileService.getAttachmentMetadataById(id).subscribe({
                next: meta => {
                    this.files.update(prev =>
                        prev.map(f =>
                            f === entry
                                ? {
                                      ...f,
                                      name: meta.fileName,
                                      isImage: meta.contentType.startsWith('image/'),
                                      isUploading: false,
                                  }
                                : f,
                        ),
                    );
                    this.releaseIfSettled();
                },
                // The id outlived the file it named. Dropped rather than shown as a failure: nobody
                // attached it this session, so there is nothing for them to retry.
                error: () => {
                    this.files.update(prev => prev.filter(f => f !== entry));
                    this.releaseIfSettled();
                },
            });
        }
    }

    /** Drops everything without touching the server, for a composer moving to another channel. */
    clear(): void {
        for (const f of this.files()) releasePreview(f.previewUrl);
        this.files.set([]);
        this.releaseIfSettled();
    }

    remove(index: number): void {
        this.files.update(prev => {
            const next = [...prev];
            releasePreview(next[index].previewUrl);
            next.splice(index, 1);
            return next;
        });
        // Removing the last file that was still uploading settles the list just as finishing it
        // would - a parked send must not wait on an attachment that is no longer there.
        this.releaseIfSettled();
    }

    /** Resolves once no attachment is still uploading. */
    settled(): Promise<void> {
        if (!this.isUploading()) return Promise.resolve();
        return new Promise<void>(resolve => this.settleWaiters.push(resolve));
    }

    private releaseIfSettled(): void {
        if (this.isUploading()) return;
        const waiting = this.settleWaiters;
        this.settleWaiters = [];
        for (const resolve of waiting) resolve();
    }

    onDragEnter(event: DragEvent): void {
        event.preventDefault();
        this.dragCounter++;
        this.isDraggingOver.set(true);
    }

    onDragOver(event: DragEvent): void {
        event.preventDefault();
    }

    onDragLeave(): void {
        if (--this.dragCounter === 0) this.isDraggingOver.set(false);
    }

    onDrop(event: DragEvent): void {
        event.preventDefault();
        this.dragCounter = 0;
        this.isDraggingOver.set(false);
        const files = event.dataTransfer?.files;
        if (files) {
            for (const file of Array.from(files)) this.attach(file);
        }
    }

    /** Returns IDs of successfully uploaded files, revokes all preview URLs, and clears the list. */
    flushAndClear(): string[] {
        const ids = this.files()
            .filter(f => f.uploadedId)
            .map(f => f.uploadedId!);
        for (const f of this.files()) releasePreview(f.previewUrl);
        this.files.set([]);
        return ids;
    }

    ngOnDestroy(): void {
        for (const f of this.files()) releasePreview(f.previewUrl);
        // Released rather than left hanging, so a parked send resolves and can see it was
        // abandoned instead of holding its captured closure for the life of the page.
        const waiting = this.settleWaiters;
        this.settleWaiters = [];
        for (const resolve of waiting) resolve();
    }
}
