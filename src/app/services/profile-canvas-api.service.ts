import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {map, Observable} from 'rxjs';
import {CanvasImageDto, CanvasWriteDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {ApiConfigService} from './api-config.service';

@Injectable({providedIn: 'root'})
export class ProfileCanvasApiService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    public get(profileId: string): Observable<ProfileCanvasDto> {
        return this.http.get<ProfileCanvasDto>(`${this.base()}/profiles/${profileId}/canvas`);
    }

    public save(body: CanvasWriteDto): Observable<ProfileCanvasDto> {
        return this.http.put<ProfileCanvasDto>(`${this.base()}/profiles/me/canvas`, body);
    }

    public uploadImage(file: File): Observable<CanvasImageDto> {
        const form = new FormData();
        form.append('file', file, file.name);
        return this.http.post<CanvasImageDto>(`${this.base()}/profiles/me/canvas/images`, form);
    }

    public deleteImage(imageId: string): Observable<void> {
        return this.http
            .delete(`${this.base()}/profiles/me/canvas/images/${imageId}`, {responseType: 'text'})
            .pipe(map(() => undefined));
    }

    /** Built from the configured base, not environment.apiUrl: self-hosted deployments exist. */
    public imageUrl(imageId: string): string {
        return `${this.base()}/canvas-images/${imageId}`;
    }

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/social`;
    }
}
