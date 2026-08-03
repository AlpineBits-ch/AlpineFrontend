import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    InboxMentionsPage,
    InboxMentionWindow,
    InboxSummary,
    InboxUnreadPage,
} from '../dtos/response/inbox.dto';

/**
 * The inbox HTTP surface, and nothing else.
 *
 * <p>Every route acts on the caller's own inbox - there is no user id in any path and no way to
 * read anyone else's, so none of these take one. State, paging and optimism all live in
 * {@link import('./inbox.service').InboxService}; this file only speaks to the server.</p>
 */
@Injectable({providedIn: 'root'})
export class InboxApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild/inbox';
    }

    /**
     * Channels with messages newer than the caller's read cursor, newest activity first.
     *
     * @param limit clamped server-side to 1-25.
     * @param cursor opaque, from the previous response. One the server does not recognise is
     *        treated as the first page rather than rejected, so a stale bookmark degrades.
     */
    unread(limit = 10, cursor?: string | null): Observable<InboxUnreadPage> {
        let params = new HttpParams().set('limit', limit);
        if (cursor) params = params.set('cursor', cursor);
        return this.http.get<InboxUnreadPage>(`${this.base}/unread`, {params});
    }

    /**
     * Messages that mentioned the caller, newest first, merging direct/`@here` with
     * `@everyone`/`@role`.
     *
     * <p>`since` is capped at the 31-day retention window regardless of what is asked for, and
     * there is no backfill before the feature shipped - this is a recent-activity view, never a
     * complete archive.</p>
     */
    mentions(opts: {
        limit?: number;
        cursor?: string | null;
        guildId?: string;
        since?: InboxMentionWindow;
    } = {}): Observable<InboxMentionsPage> {
        let params = new HttpParams().set('limit', opts.limit ?? 25);
        if (opts.cursor) params = params.set('cursor', opts.cursor);
        if (opts.guildId) params = params.set('guildId', opts.guildId);
        if (opts.since) params = params.set('since', opts.since);
        return this.http.get<InboxMentionsPage>(`${this.base}/mentions`, {params});
    }

    /** The header badge. */
    summary(): Observable<InboxSummary> {
        return this.http.get<InboxSummary>(`${this.base}/summary`);
    }

    /** Marks one channel read up to its current head. A channel with no messages is a no-op, not an error. */
    markChannelRead(channelId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/channels/${channelId}/read`, null);
    }

    /**
     * Marks every channel in every guild read.
     *
     * <p>Idempotent, and rate-limited: it is a bulk write across the caller's whole account, so it
     * must never be put on a timer.</p>
     */
    readAll(): Observable<void> {
        return this.http.post<void>(`${this.base}/read-all`, null);
    }

    /**
     * Dismisses one mention.
     *
     * @param createdAt <b>the exact string off the mention row</b>, not a re-serialized `Date`.
     *        The index is keyed on it, so a mismatch silently deletes nothing and the row comes
     *        back on the next fetch.
     */
    dismissMention(messageId: string, createdAt: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/mentions/${messageId}`, {
            params: new HttpParams().set('createdAt', createdAt),
        });
    }
}
