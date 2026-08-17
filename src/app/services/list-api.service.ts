import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ListItem} from '../dtos/response/list.dto';
import {CreateListItemDto, ReorderListItemsDto, UpdateListItemDto} from '../dtos/request/list.dto';

/**
 * The `List` channel HTTP surface, and nothing else.
 *
 * <p>State, optimism and realtime reconciliation live in
 * {@link import('./list.service').ListService}; this file only speaks to the server.</p>
 *
 * <p>Two path shapes, and they are not interchangeable: creating, listing, reordering and clearing
 * are addressed by *channel*, while editing, ticking and deleting are addressed by *item* and carry
 * no channel segment at all. The doubled-looking `/api/v1/guild/...` prefix is correct - the
 * gateway strips the `guild` segment before forwarding.</p>
 */
@Injectable({providedIn: 'root'})
export class ListApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /**
     * Every row in the channel.
     *
     * @param includeChecked defaults to `true` here, unlike the endpoint's own `false`. A shopping
     *        list that hides what has been ticked cannot strike anything through, and striking
     *        through is the whole point of the shared list - hiding done rows is a view filter,
     *        applied locally.
     */
    items(channelId: string, includeChecked = true): Observable<ListItem[]> {
        return this.http.get<ListItem[]>(`${this.base}/channels/${channelId}/list-items`, {
            params: new HttpParams().set('includeChecked', includeChecked),
        });
    }

    /** `400` past 200 chars of `text` or 500 rows in the channel - both are pre-checked client-side. */
    create(channelId: string, dto: CreateListItemDto): Observable<ListItem> {
        return this.http.post<ListItem>(`${this.base}/channels/${channelId}/list-items`, dto);
    }

    /** Needs `AddListItems` for your own row, `ManageLists` for anyone else's. */
    update(itemId: string, dto: UpdateListItemDto): Observable<ListItem> {
        return this.http.patch<ListItem>(`${this.base}/list-items/${itemId}`, dto);
    }

    /**
     * Ticks a row. **Idempotent**: re-ticking an already-ticked row returns `200` with the item
     * unchanged and broadcasts nothing, so a repeat is a success, never an error.
     */
    check(itemId: string): Observable<ListItem> {
        return this.http.post<ListItem>(`${this.base}/list-items/${itemId}/check`, null);
    }

    /** Unticks. Same route, same idempotence - the verb is the only difference. */
    uncheck(itemId: string): Observable<ListItem> {
        return this.http.delete<ListItem>(`${this.base}/list-items/${itemId}/check`);
    }

    remove(itemId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/list-items/${itemId}`);
    }

    /**
     * Partial order: ids omitted keep their relative order *after* those sent. See
     * `reorderByPartialIds` for the rule, and `ListService.moveItem` for why the payload is a
     * prefix rather than a two-element swap.
     */
    reorder(channelId: string, dto: ReorderListItemsDto): Observable<void> {
        return this.http.post<void>(`${this.base}/channels/${channelId}/list-items/reorder`, dto);
    }

    /**
     * "Clear done" - drops every checked row. Needs `ManageLists`.
     *
     * <p>The response body is undocumented; the count is only reliably available on the
     * `guild.ListCleared` broadcast, so the caller must treat `null` as "it worked, count
     * unknown" rather than as a failure.</p>
     */
    clearChecked(channelId: string): Observable<{removedCount: number} | null> {
        return this.http.delete<{removedCount: number} | null>(
            `${this.base}/channels/${channelId}/list-items/checked`,
        );
    }
}
