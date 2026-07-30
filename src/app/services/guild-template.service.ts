import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {CreateTemplateDto, GuildTemplateDto, UseTemplateDto} from '../dtos/response/guild-template.dto';

export interface CreatedTemplateDto {
    id: string;
    name: string;
    description?: string | null;
    createdAt: string;
}

export interface NewGuildFromTemplateDto {
    id: string;
    name: string;
}

@Injectable({providedIn: 'root'})
export class GuildTemplateService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);
    private base = this.apiConfig.baseUrl() + '/api/v1/guild';

    createFromGuild(guildId: string, dto: CreateTemplateDto): Observable<CreatedTemplateDto> {
        return this.http.post<CreatedTemplateDto>(`${this.base}/guilds/${guildId}/templates`, dto);
    }

    get(id: string): Observable<GuildTemplateDto> {
        return this.http.get<GuildTemplateDto>(`${this.base}/templates/${id}`);
    }

    useTemplate(id: string, dto: UseTemplateDto): Observable<NewGuildFromTemplateDto> {
        return this.http.post<NewGuildFromTemplateDto>(`${this.base}/templates/${id}/use`, dto);
    }
}
