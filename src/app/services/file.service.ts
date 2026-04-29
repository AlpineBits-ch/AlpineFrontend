import {inject, Injectable} from '@angular/core';
import {EMPTY, expand, filter, flatMap, Observable, switchMap, take, throwError, timer} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {environment} from "../../environments/environment";

export interface PresignedResponse {
  attachmentId: string;
  url: string;
}
export enum AttachmentStatus {
  Pending = 'Pending',
  Processing = 'Processing',
  Complete = 'Complete',
  Failed = 'Failed'
}
interface UploadResponse {
  attachmentId: string; // The ID returned from the POST
  state: AttachmentStatus;
}
@Injectable({
  providedIn: 'root',
})
export class FileService {

  private httpClient = inject(HttpClient);
  public uploadFile(file: File): Observable<any> {
    const url = `${environment.apiUrl}/api/v1/messaging/attachments`;

    // 1. Prepare FormData for [FromForm] ICollection<IFormFile>
    const formData = new FormData();
    formData.append('files', file, file.name);

    return this.httpClient.post<UploadResponse[]>(url, formData).pipe(
        switchMap((initialResponse) => {
          const fileId = initialResponse[0].attachmentId;
          // 2. Start polling the status endpoint
          return this.pollFileStatus(fileId);
        })
    );
  }
  private pollFileStatus(fileId: string): Observable<any> {
    const pollUrl = `${environment.apiUrl}/api/v1/messaging/attachments/${fileId}`;

    return this.httpClient.get<any>(pollUrl).pipe(
        // expand will recursively call this logic
        expand((res) => {
          const isFinished = res.state === AttachmentStatus.Complete || res.status === AttachmentStatus.Failed;
          // If not finished, wait 2 seconds and call the API again
          return isFinished ? EMPTY : timer(2000).pipe(switchMap(() => this.httpClient.get<any>(pollUrl)));
        }),
        // Filter so the component only gets the final result
        filter(res => res.status === AttachmentStatus.Complete || res.status === AttachmentStatus.Failed),
        take(1),
        switchMap(res => {
          if (res.status === AttachmentStatus.Failed) {
            return throwError(() => new Error('File processing failed at server.'));
          }
          return [res];
        })
    );
  }
}
