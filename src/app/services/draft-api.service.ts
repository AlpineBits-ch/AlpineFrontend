import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, of} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {ApiConfigService} from './api-config.service';
import {MessageDraftDto, SaveMessageDraftDto} from '../dtos/response/draft.dto';

/** Server-side drafts, as an injectable seam. `app.config.ts` binds the implementation. */
@Injectable()
export abstract class DraftApi {
    /**
     * Every draft this account holds. Read once a session so the channel list can mark the channels
     * with something waiting in them, which a per-channel read cannot answer for a channel nobody
     * has opened.
     */
    abstract list(): Observable<MessageDraftDto[]>;

    /** Null when there is no draft, which is not an error. */
    abstract get(channelId: string): Observable<MessageDraftDto | null>;

    abstract save(channelId: string, dto: SaveMessageDraftDto): Observable<MessageDraftDto>;

    abstract discard(channelId: string): Observable<void>;
}

@Injectable()
export class HttpDraftApi extends DraftApi {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/messaging/drafts`;
    }

    private url(channelId: string): string {
        return `${this.base}/${channelId}`;
    }

    list(): Observable<MessageDraftDto[]> {
        return this.http.get<MessageDraftDto[]>(this.base).pipe(catchError(() => of([])));
    }

    get(channelId: string): Observable<MessageDraftDto | null> {
        // An empty channel answers 404, and a missing draft is the normal case rather than a fault.
        return this.http.get<MessageDraftDto>(this.url(channelId)).pipe(catchError(() => of(null)));
    }

    save(channelId: string, dto: SaveMessageDraftDto): Observable<MessageDraftDto> {
        return this.http.put<MessageDraftDto>(this.url(channelId), dto);
    }

    discard(channelId: string): Observable<void> {
        return this.http.delete<void>(this.url(channelId));
    }
}
