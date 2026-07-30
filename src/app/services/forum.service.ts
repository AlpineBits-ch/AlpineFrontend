import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ForumConfig, ForumPost, ForumPostPage, ForumPostQuery, ForumTag} from '../dtos/response/forum.dto';
import {
    CreateForumTagDto,
    ReorderForumTagsDto,
    SetPostLockedDto,
    SetPostPinnedDto,
    SetPostTagsDto,
    UpdateForumConfigDto,
    UpdateForumTagDto,
} from '../dtos/request/forum.dto';

@Injectable({providedIn: 'root'})
export class ForumService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Tags ─────────────────────────────────────────────────────────────────
    getTags(forumId: string): Observable<ForumTag[]> {
        return this.http.get<ForumTag[]>(`${this.base}/channels/${forumId}/tags`);
    }

    createTag(forumId: string, dto: CreateForumTagDto): Observable<ForumTag> {
        return this.http.post<ForumTag>(`${this.base}/channels/${forumId}/tags`, dto);
    }

    updateTag(tagId: string, dto: UpdateForumTagDto): Observable<ForumTag> {
        return this.http.patch<ForumTag>(`${this.base}/forum-tags/${tagId}`, dto);
    }

    deleteTag(tagId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/forum-tags/${tagId}`);
    }

    /** Send every tag id in the forum - positions come from the array index. */
    reorderTags(forumId: string, dto: ReorderForumTagsDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/channels/${forumId}/tags/reorder`, dto);
    }

    // ── Config ───────────────────────────────────────────────────────────────
    getConfig(forumId: string): Observable<ForumConfig> {
        return this.http.get<ForumConfig>(`${this.base}/channels/${forumId}/forum-config`);
    }

    updateConfig(forumId: string, dto: UpdateForumConfigDto): Observable<ForumConfig> {
        return this.http.patch<ForumConfig>(`${this.base}/channels/${forumId}/forum-config`, dto);
    }

    // ── Posts ────────────────────────────────────────────────────────────────
    /**
     * Keyset-paginated. The cursor encodes the sort and filters it was issued under,
     * so changing any of them means starting over from the first page.
     */
    getPosts(forumId: string, query: ForumPostQuery = {}): Observable<ForumPostPage> {
        let params = new HttpParams();
        if (query.tagIds?.length) params = params.set('tagIds', query.tagIds.join(','));
        if (query.match) params = params.set('match', query.match);
        if (query.sort) params = params.set('sort', query.sort);
        if (query.archived) params = params.set('archived', query.archived);
        if (query.limit) params = params.set('limit', String(query.limit));
        if (query.cursor) params = params.set('cursor', query.cursor);

        return this.http.get<ForumPostPage>(`${this.base}/channels/${forumId}/posts`, {params});
    }

    /** Replace semantics: the full desired set, which keeps retries idempotent. */
    setPostTags(threadId: string, dto: SetPostTagsDto): Observable<ForumPost> {
        return this.http.put<ForumPost>(`${this.base}/threads/${threadId}/tags`, dto);
    }

    setPostPinned(threadId: string, dto: SetPostPinnedDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/threads/${threadId}/pin`, dto);
    }

    setPostLocked(threadId: string, dto: SetPostLockedDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/threads/${threadId}/lock`, dto);
    }
}
