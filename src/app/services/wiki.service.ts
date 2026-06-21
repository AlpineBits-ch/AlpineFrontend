import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {catchError, Observable, of} from 'rxjs';
import {environment} from '../../environments/environment';
import {WikiCategoryDto, WikiDto, WikiPageDto, WikiRevisionDto} from '../dtos/response/wiki.dto';
import {
    CreateWikiCategoryDto,
    CreateWikiPageDto,
    UpdateWikiCategoryDto,
    UpdateWikiPageDto,
} from '../dtos/request/wiki.dto';
import {ApiConfigService} from "./api-config.service";

@Injectable({providedIn: 'root'})
export class WikiService {
    private apiConfig = inject(ApiConfigService);

    private readonly http = inject(HttpClient);
    private readonly base = this.apiConfig.baseUrl() + '/api/v1/guild';

    getWiki(guildId: string): Observable<WikiDto> {
        return this.http.get<WikiDto>(`${this.base}/guilds/${guildId}/wiki`).pipe(
            catchError(() => of({id: '', guildId, categories: [], pages: []} as WikiDto)),
        );
    }

    getPage(guildId: string, pageId: string): Observable<WikiPageDto> {
        return this.http.get<WikiPageDto>(`${this.base}/guilds/${guildId}/wiki/pages/${pageId}`);
    }

    createPage(guildId: string, dto: CreateWikiPageDto): Observable<WikiPageDto> {
        return this.http.post<WikiPageDto>(`${this.base}/guilds/${guildId}/wiki/pages`, dto);
    }

    updatePage(guildId: string, pageId: string, dto: UpdateWikiPageDto): Observable<WikiPageDto> {
        return this.http.put<WikiPageDto>(`${this.base}/guilds/${guildId}/wiki/pages/${pageId}`, dto);
    }

    deletePage(guildId: string, pageId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/wiki/pages/${pageId}`);
    }

    getRevisions(guildId: string, pageId: string): Observable<WikiRevisionDto[]> {
        return this.http.get<WikiRevisionDto[]>(
            `${this.base}/guilds/${guildId}/wiki/pages/${pageId}/revisions`,
        );
    }

    restoreRevision(guildId: string, pageId: string, revisionId: string): Observable<WikiPageDto> {
        return this.http.post<WikiPageDto>(
            `${this.base}/guilds/${guildId}/wiki/pages/${pageId}/revisions/${revisionId}/restore`,
            {},
        );
    }

    createCategory(guildId: string, dto: CreateWikiCategoryDto): Observable<WikiCategoryDto> {
        return this.http.post<WikiCategoryDto>(`${this.base}/guilds/${guildId}/wiki/categories`, dto);
    }

    updateCategory(
        guildId: string,
        categoryId: string,
        dto: UpdateWikiCategoryDto,
    ): Observable<WikiCategoryDto> {
        return this.http.put<WikiCategoryDto>(
            `${this.base}/guilds/${guildId}/wiki/categories/${categoryId}`,
            dto,
        );
    }

    deleteCategory(guildId: string, categoryId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/wiki/categories/${categoryId}`);
    }
}
