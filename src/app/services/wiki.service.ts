import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {catchError, Observable, of} from 'rxjs';
import {
    WikiCategoryDto,
    WikiDto,
    WikiGraphDto,
    WikiPageDto,
    WikiRevisionDto,
} from '../dtos/response/wiki.dto';
import {
    CreateWikiCategoryDto,
    CreateWikiPageDto,
    UpdateWikiCategoryDto,
    UpdateWikiPageDto,
} from '../dtos/request/wiki.dto';
import {ApiConfigService} from './api-config.service';

@Injectable({providedIn: 'root'})
export class WikiService {
    private apiConfig = inject(ApiConfigService);

    private readonly http = inject(HttpClient);
    private readonly base = this.apiConfig.baseUrl() + '/api/v1/guild';

    /** The tree without bodies. Errors reach the caller, so a failed load can be told from an empty wiki. */
    getWikiTree(guildId: string): Observable<WikiDto> {
        return this.http.get<WikiDto>(`${this.base}/guilds/${guildId}/wiki`);
    }

    /**
     * As {@link getWikiTree}, but a failure reads as an empty wiki.
     *
     * For callers that only want a page or category list and have no failure state to render.
     * Anything that draws the wiki itself wants `getWikiTree`, or it reports "no pages yet" to a
     * member of a wiki that merely failed to load.
     */
    getWiki(guildId: string): Observable<WikiDto> {
        return this.getWikiTree(guildId).pipe(
            catchError(() => of({id: '', guildId, categories: [], pages: []} as WikiDto)),
        );
    }

    /**
     * The content-bearing fetch, used to warm the search and backlink index.
     *
     * Deliberately not a flag on `getWiki`: that method swallows errors into an empty wiki so the
     * tree degrades to "no pages yet" rather than a broken view. Reusing it here would turn a
     * failed warm into a *successful* empty one, and search would report full-text coverage it
     * does not have. This one lets the error through so the caller can say so.
     */
    getWikiWithContent(guildId: string): Observable<WikiDto> {
        return this.http.get<WikiDto>(`${this.base}/guilds/${guildId}/wiki`, {
            params: {includeContent: true},
        });
    }

    /**
     * The link map, without any page bodies. Edges are body links only; the tree comes from
     * `nodes[].parentPageId`.
     *
     * Errors pass through for the same reason as {@link getWikiWithContent}: a swallowed failure
     * would draw an empty map and present it as a wiki with nothing linked. A 404 additionally
     * carries information the caller needs, since a server without this endpoint answers 404.
     */
    getGraph(guildId: string): Observable<WikiGraphDto> {
        return this.http.get<WikiGraphDto>(`${this.base}/guilds/${guildId}/wiki/graph`);
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
