import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    GuildLinkDto,
    GuildLinkStatus,
    ImportJobDto,
    StartImportResponseDto,
} from '../dtos/response/discord-import.dto';

@Injectable({providedIn: 'root'})
export class DiscordImportService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/imports`;
    }

    startImport(): Observable<StartImportResponseDto> {
        return this.http.get<StartImportResponseDto>(`${this.base()}/discord/start`);
    }

    getJob(jobId: string): Observable<ImportJobDto> {
        return this.http.get<ImportJobDto>(`${this.base()}/jobs/${encodeURIComponent(jobId)}`);
    }

    getLinks(guildId: string): Observable<GuildLinkDto[]> {
        return this.http.get<GuildLinkDto[]>(`${this.base()}/links`, {params: {guildId}});
    }

    setLinkStatus(linkId: string, status: Extract<GuildLinkStatus, 'Active' | 'Paused'>): Observable<GuildLinkDto> {
        return this.http.patch<GuildLinkDto>(`${this.base()}/links/${encodeURIComponent(linkId)}`, {status});
    }

    unlink(linkId: string): Observable<void> {
        return this.http.delete<void>(`${this.base()}/links/${encodeURIComponent(linkId)}`);
    }
}
