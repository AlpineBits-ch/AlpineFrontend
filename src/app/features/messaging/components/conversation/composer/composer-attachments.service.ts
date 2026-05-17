import {inject, Injectable, OnDestroy, signal} from '@angular/core';
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
    private fileService = inject(FileService);
    private dragCounter = 0;

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
            },
            error: () => {
                this.files.update(prev =>
                    prev.map(f => f === entry ? {...f, isUploading: false, uploadFailed: true} : f)
                );
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
        const ids = this.files().filter(f => f.uploadedId).map(f => f.uploadedId!);
        for (const f of this.files()) URL.revokeObjectURL(f.previewUrl);
        this.files.set([]);
        return ids;
    }

    ngOnDestroy(): void {
        for (const f of this.files()) URL.revokeObjectURL(f.previewUrl);
    }
}
