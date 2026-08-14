import {computed, inject, Injectable, OnDestroy, signal} from '@angular/core';
import {uploadFailureKey} from '../../../../../core/entitlement-message';
import {FileService} from '../../../../../services/file.service';
import {EntitlementStore} from '../../../../../stores/entitlement.store';

export interface AttachedFile {
    file: File;
    previewUrl: string;
    name: string;
    isImage: boolean;
    uploadedId?: string;
    isUploading: boolean;
    uploadFailed: boolean;
    /**
     * Why it failed, as a translation key. Present only on a failure, and specific enough to be
     * worth showing: one badge that could not tell "too large for this plan" from "the network
     * died" was the whole of the feedback this path used to give.
     */
    errorKey?: string;
}

@Injectable()
export class ComposerAttachmentsService implements OnDestroy {
    readonly files = signal<AttachedFile[]>([]);
    readonly isDraggingOver = signal(false);
    /**
     * The guild the composer is writing into, or null in a DM. It selects which upload ceiling
     * applies: `storage.upload_max_bytes` inside a guild, `user.upload_max_bytes` outside one.
     */
    readonly guildId = signal<string | null>(null);
    /** True while at least one attachment has no id yet, so a send now would go without it. */
    readonly isUploading = computed(() => this.files().some(f => f.isUploading));
    /** True once an upload has given up, so a send now would go without that file for good. */
    readonly hasFailed = computed(() => this.files().some(f => f.uploadFailed));
    /** The first failure's reason, for a caller that shows one sentence rather than one per file. */
    readonly failureKey = computed(() => this.files().find(f => f.uploadFailed)?.errorKey ?? null);
    private fileService = inject(FileService);
    private entitlements = inject(EntitlementStore);
    private dragCounter = 0;
    /** Resolvers parked by {@link settled}, released together the moment nothing is in flight. */
    private settleWaiters: (() => void)[] = [];

    /**
     * Queue a file, checking it against the server's ceiling before spending the transfer on it.
     *
     * <p>The check is a courtesy rather than the enforcement - the ceiling can move between the read
     * and the upload, and the client is not the thing that decides - so the `403` and the `413` are
     * still handled below. What it buys is that a 200 MB file is refused instantly and by name,
     * instead of after a minute of upload and a generic badge.</p>
     *
     * <p>An oversized file in a batch is refused on its own. The others still go.</p>
     */
    attach(file: File): void {
        const isImage = file.type.startsWith('image/');
        const previewUrl = URL.createObjectURL(file);

        const ceiling = this.entitlements.uploadCeilingBytes(this.guildId());
        if (ceiling !== null && file.size > ceiling) {
            this.files.update(prev => [...prev, {
                file, previewUrl, name: file.name, isImage,
                isUploading: false, uploadFailed: true, errorKey: 'COMPOSER.UPLOAD_TOO_LARGE',
            }]);
            return;
        }

        const entry: AttachedFile = {
            file,
            previewUrl,
            name: file.name,
            isImage,
            isUploading: true,
            uploadFailed: false
        };
        this.files.update(prev => [...prev, entry]);

        this.fileService.uploadFile(file).subscribe({
            next: (response) => {
                this.files.update(prev =>
                    prev.map(f => f === entry ? {...f, uploadedId: response.id, isUploading: false} : f)
                );
                this.releaseIfSettled();
            },
            error: (err: unknown) => {
                const errorKey = uploadFailureKey(err);
                this.files.update(prev =>
                    prev.map(f => f === entry ? {...f, isUploading: false, uploadFailed: true, errorKey} : f)
                );
                this.releaseIfSettled();
            },
        });
    }

    remove(index: number): void {
        this.files.update(prev => {
            const next = [...prev];
            URL.revokeObjectURL(next[index].previewUrl);
            next.splice(index, 1);
            return next;
        });
        // Removing the last file that was still uploading settles the list just as finishing it
        // would - a parked send must not wait on an attachment that is no longer there.
        this.releaseIfSettled();
    }

    /**
     * Resolves once no attachment is still uploading.
     *
     * <p>Settled means "nothing in flight", not "everything succeeded" - a failed upload settles
     * too. The caller decides what to do about {@link hasFailed}; this only says the outcome is
     * known.</p>
     */
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

    /**
     * Returns IDs of successfully uploaded files, revokes all preview URLs, and clears the list.
     *
     * <p>Only call once {@link settled} has resolved and {@link hasFailed} is false. Anything else
     * is silently dropped here, which is how pressing Enter mid-upload used to post the message
     * without the files it was written about.</p>
     */
    flushAndClear(): string[] {
        const ids = this.files().filter(f => f.uploadedId).map(f => f.uploadedId!);
        for (const f of this.files()) URL.revokeObjectURL(f.previewUrl);
        this.files.set([]);
        return ids;
    }

    ngOnDestroy(): void {
        for (const f of this.files()) URL.revokeObjectURL(f.previewUrl);
        // Released rather than left hanging, so a parked send resolves and can see it was
        // abandoned instead of holding its captured closure for the life of the page.
        const waiting = this.settleWaiters;
        this.settleWaiters = [];
        for (const resolve of waiting) resolve();
    }
}
