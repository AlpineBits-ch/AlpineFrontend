import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    SetWikiPagePublicationDto,
    SetWikiPublicationDto,
    WikiPagePublicationDto,
    WikiPublicationDto,
} from '../dtos/response/wiki-publication.dto';

/** Publishing a wiki to the public host, as an injectable seam. `app.config.ts` binds the implementation. */
@Injectable()
export abstract class WikiPublicationApi {
    abstract get(guildId: string): Observable<WikiPublicationDto>;

    /** 409 when the slug is taken, which is the expected answer often enough to be a normal path. */
    abstract set(guildId: string, dto: SetWikiPublicationDto): Observable<WikiPublicationDto>;

    /** 400 with a `{error, message}` body when the page itself refuses. See `wiki-publish-refusal.ts`. */
    abstract setPage(
        guildId: string,
        pageId: string,
        dto: SetWikiPagePublicationDto,
    ): Observable<WikiPagePublicationDto>;
}

@Injectable()
export class HttpWikiPublicationApi extends WikiPublicationApi {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    get(guildId: string): Observable<WikiPublicationDto> {
        return this.http.get<WikiPublicationDto>(`${this.base}/guilds/${guildId}/wiki/publication`);
    }

    set(guildId: string, dto: SetWikiPublicationDto): Observable<WikiPublicationDto> {
        return this.http.put<WikiPublicationDto>(`${this.base}/guilds/${guildId}/wiki/publication`, dto);
    }

    setPage(
        guildId: string,
        pageId: string,
        dto: SetWikiPagePublicationDto,
    ): Observable<WikiPagePublicationDto> {
        return this.http.put<WikiPagePublicationDto>(
            `${this.base}/guilds/${guildId}/wiki/pages/${pageId}/publication`,
            dto,
        );
    }
}
