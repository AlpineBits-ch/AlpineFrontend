import {computed, inject, Injectable, OnDestroy, signal} from '@angular/core';
import {FileService} from '../../../../../services/file.service';

export interface AttachedFile {
    file: File;
    previewUrl: string;
    name: string;
    isImage: boolean;
    uploadedId?: string;
    isUploading: boolean;
    uploadFailed: boolean;
}

@Injectable()
export class ComposerAttachmentsService implements OnDestroy {
    readonly files = signal<AttachedFile[]>([]);
    readonly isDraggingOver = signal(false);
    /** True while at least one attachment has no id yet, so a send now would go without it. */
    readonly isUploading = computed(() => this.files().some(f => f.isUploading));
    /** True once an upload has given up, so a send now would go without that file for good. */
    readonly hasFailed = computed(() => this.files().some(f => f.uploadFailed));
    private fileService = inject(FileService);
    private dragCounter = 0;
    /** Resolvers parked by {@link settled}, released together the moment nothing is in flight. */
    private settleWaiters: (() => void)[] = [];

    attach(file: File): void {
        const isImage = file.type.startsWith('image/');
        const previewUrl = URL.createObjectURL(file);
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
            error: () => {
                this.files.update(prev =>
                    prev.map(f => f === entry ? {...f, isUploading: false, uploadFailed: true} : f)
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
