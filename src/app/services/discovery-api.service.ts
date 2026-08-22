import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    DiscoveryFeedDto,
    InterestsDto,
    ListingDto,
    TopicSearchResultDto,
} from '../dtos/response/discovery.dto';
import {
    DiscoveryFeedQuery,
    ListingWriteDto,
    SaveInterestsDto,
    TopicSearchQuery,
} from '../dtos/request/discovery.dto';

/**
 * The Discovery HTTP surface, and nothing else. Caching, state and realtime reconciliation live in
 * {@link import('../stores/discovery.store').DiscoveryStore}.
 *
 * The `/discovery` segment in {@link base} is correct even though the gateway strips it before the
 * request reaches the service: the gateway consumes that segment, and the client must still send it.
 */
@Injectable({providedIn: 'root'})
export class DiscoveryApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/discovery';
    }

    discover(query: DiscoveryFeedQuery & {cursor?: string}): Observable<DiscoveryFeedDto> {
        let params = new HttpParams();
        if (query.q) params = params.set('q', query.q);
        if (query.topics?.length) params = params.set('topics', query.topics.join(','));
        if (query.language) params = params.set('language', query.language);
        if (query.cursor) params = params.set('cursor', query.cursor);
        if (query.limit != null) params = params.set('limit', query.limit);
        return this.http.get<DiscoveryFeedDto>(`${this.base}/discover`, {params});
    }

    searchTopics(query: TopicSearchQuery): Observable<TopicSearchResultDto> {
        let params = new HttpParams();
        if (query.q) params = params.set('q', query.q);
        if (query.limit != null) params = params.set('limit', query.limit);
        return this.http.get<TopicSearchResultDto>(`${this.base}/topics/search`, {params});
    }

    getInterests(): Observable<InterestsDto> {
        return this.http.get<InterestsDto>(`${this.base}/me/interests`);
    }

    saveInterests(dto: SaveInterestsDto): Observable<InterestsDto> {
        return this.http.put<InterestsDto>(`${this.base}/me/interests`, dto);
    }

    /** A guild that has never drafted a listing answers `404`. */
    getListing(guildId: string): Observable<ListingDto> {
        return this.http.get<ListingDto>(`${this.base}/guilds/${guildId}/listing`);
    }

    saveListing(guildId: string, dto: ListingWriteDto): Observable<ListingDto> {
        return this.http.put<ListingDto>(`${this.base}/guilds/${guildId}/listing`, dto);
    }

    /** Answers `403` when the guild's plan does not include Discovery. */
    publish(guildId: string): Observable<ListingDto> {
        return this.http.post<ListingDto>(`${this.base}/guilds/${guildId}/listing/publish`, {});
    }

    unlist(guildId: string): Observable<ListingDto> {
        return this.http.post<ListingDto>(`${this.base}/guilds/${guildId}/listing/unlist`, {});
    }

    /** Answers `409` while {@link ListingDto.bumpAvailableAt} is still in the future. */
    bump(guildId: string): Observable<ListingDto> {
        return this.http.post<ListingDto>(`${this.base}/guilds/${guildId}/listing/bump`, {});
    }
}
