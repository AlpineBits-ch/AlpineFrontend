import {inject, Injectable} from '@angular/core';
import {EMPTY, expand, filter, Observable, switchMap, take, throwError, timer} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {ApiConfigService} from './api-config.service';

/** No `url` field: the server does not send one. Use {@link FileService.attachmentDownloadUrl} with the id. */
export interface AttachmentDto {
    id: string;
    fileName: string;
    contentType: string;
    createdAt: Date;
    updatedAt: Date;
    state: AttachmentStatus;
    thumbnailUrl?: string;
}

export interface PresignedResponse {
    attachmentId: string;
    url: string;
}

export enum AttachmentStatus {
    Pending = 'Pending',
    Processing = 'Processing',
    Complete = 'Complete',
    Failed = 'Failed',
}

interface UploadResponse {
    attachmentId: string;
    state: AttachmentStatus;
}

@Injectable({
    providedIn: 'root',
})
export class FileService {
    private httpClient = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    public uploadFile(file: File): Observable<AttachmentDto> {
        const url = `${this.apiConfig.baseUrl()}/api/v1/messaging/attachments`;

        // 1. Prepare FormData for [FromForm] ICollection<IFormFile>
        const formData = new FormData();
        formData.append('files', file, file.name);

        return this.httpClient.post<UploadResponse[]>(url, formData).pipe(
            switchMap(initialResponse => {
                const fileId = initialResponse[0].attachmentId;
                // 2. Start polling the status endpoint
                return this.pollFileStatus(fileId);
            }),
        );
    }

    /** The address of an attachment's full-size bytes; always build it from the id, since the payload only carries `thumbnailUrl`. */
    public attachmentDownloadUrl(id: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/messaging/attachments/${id}/download`;
    }

    /** The address of an attachment's preview. Same shape the server puts in `thumbnailUrl`, which a realtime payload can leave empty. */
    public attachmentThumbnailUrl(id: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/messaging/attachments/${id}/thumbnail`;
    }

    public downloadAttachmentById(id: string) {
        return this.httpClient.get(this.attachmentDownloadUrl(id), {responseType: 'blob'});
    }

    public getAttachmentMetadataById(id: string): Observable<AttachmentDto> {
        return this.httpClient.get<AttachmentDto>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/attachments/${id}`,
        );
    }

    private pollFileStatus(fileId: string): Observable<AttachmentDto> {
        const pollUrl = `${this.apiConfig.baseUrl()}/api/v1/messaging/attachments/${fileId}`;

        return this.httpClient.get<AttachmentDto>(pollUrl).pipe(
            // expand will recursively call this logic
            expand(res => {
                const isFinished =
                    res.state === AttachmentStatus.Complete || res.state === AttachmentStatus.Failed;
                // If not finished, wait 2 seconds and call the API again
                return isFinished
                    ? EMPTY
                    : timer(2000).pipe(switchMap(() => this.httpClient.get<any>(pollUrl)));
            }),
            // Filter so the component only gets the final result
            filter(res => res.state === AttachmentStatus.Complete || res.state === AttachmentStatus.Failed),
            take(1),
            switchMap(res => {
                if (res.state === AttachmentStatus.Failed) {
                    return throwError(() => new Error('File processing failed at server.'));
                }
                return [res];
            }),
        );
    }
}
