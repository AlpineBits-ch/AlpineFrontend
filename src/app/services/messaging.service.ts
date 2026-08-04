import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from "@angular/common/http";
import {Observable, Subject} from "rxjs";
import {environment} from "../../environments/environment";
import {CreateMessageDto} from "../dtos/request/create-message.dto";
import {EmbedSuppressionResponse, MessageDto, PinMessageResponse} from "../dtos/response/message.dto";
import {CreateReactionDto} from "../dtos/request/create-reaction.dto";
import {RemoveReactionDto} from "../dtos/request/remove-reaction.dto";
import {ApiConfigService} from "./api-config.service";
import {PublishResponse} from "../dtos/response/channel-follow.dto";

/** Server caps this at 50 and silently falls back to 25 for anything out of range. */
const SEARCH_LIMIT = 50;

@Injectable({
    providedIn: 'root',
})
export class MessagingService {
    readonly messageSentObservable = new Subject<MessageDto>();
    private httpClient = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private baseUrl = this.apiConfig.baseUrl();

    public createMessage(createConversationDto: CreateMessageDto): Observable<MessageDto> {
        return this.httpClient.post<MessageDto>(this.apiConfig.baseUrl() + '/api/v1/messaging/messaging', createConversationDto);
    }

    public getMessagesForConversation(conversationId: string, offset: number, limit: number): Observable<MessageDto[]> {
        return this.httpClient.get<MessageDto[]>(this.apiConfig.baseUrl() + '/api/v1/messaging/messaging/conversations/' + conversationId + '/messages?offset=' + offset + '&limit=' + limit);
    }

    public getMessagesForChannel(channelId: string, offset: number, limit: number): Observable<MessageDto[]> {
        return this.httpClient.get<MessageDto[]>(this.apiConfig.baseUrl() + '/api/v1/messaging/messaging/channels/' + channelId + '/messages?offset=' + offset + '&limit=' + limit);
    }

    public deleteMessage(messageId: string): Observable<void> {
        return this.httpClient.delete<void>(this.apiConfig.baseUrl() + '/api/v1/messaging/messaging/' + messageId);
    }

    public updateMessage(messageId: string, content: string): Observable<MessageDto> {
        return this.httpClient.put<MessageDto>(this.apiConfig.baseUrl() + '/api/v1/messaging/messaging/' + messageId, {content});
    }

    /**
     * Single flat search route scoped by query param - there is no per-channel search
     * path. Relevance-ordered (best match first), not chronological, and MLS-encrypted
     * messages are never indexed so encrypted conversations always come back empty.
     */
    public searchMessagesForChannel(channelId: string, query: string): Observable<MessageDto[]> {
        return this.httpClient.get<MessageDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/search`,
            {params: new HttpParams().set('query', query).set('channelId', channelId).set('limit', SEARCH_LIMIT)}
        );
    }

    public searchMessagesForConversation(conversationId: string, query: string): Observable<MessageDto[]> {
        return this.httpClient.get<MessageDto[]>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/search`,
            {params: new HttpParams().set('query', query).set('conversationId', conversationId).set('limit', SEARCH_LIMIT)}
        );
    }

    public getMessageById(params: {
        messageId: string;
        conversationId?: string;
        channelId?: string
    }): Observable<MessageDto> {
        const {messageId, conversationId, channelId} = params;
        if (conversationId) {
            return this.httpClient.get<MessageDto>(
                `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/conversations/${conversationId}/messages/${messageId}`
            );
        }
        return this.httpClient.get<MessageDto>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/channels/${channelId}/messages/${messageId}`
        );
    }

    public addReaction(messageId: string, dto: CreateReactionDto): Observable<void> {
        return this.httpClient.post<void>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messages/${messageId}/reactions`, dto);
    }

    public removeReaction(messageId: string, dto: RemoveReactionDto): Observable<void> {
        return this.httpClient.delete<void>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messages/${messageId}/reactions`, {body: dto});
    }

    public pinMessage(messageId: string): Observable<PinMessageResponse> {
        return this.httpClient.post<PinMessageResponse>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/pin`, null);
    }

    public unpinMessage(messageId: string): Observable<PinMessageResponse> {
        return this.httpClient.delete<PinMessageResponse>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/pin`);
    }

    public getPinnedMessages(params: { channelId?: string; conversationId?: string }): Observable<MessageDto[]> {
        const query = params.channelId ? `channelId=${params.channelId}` : `conversationId=${params.conversationId}`;
        return this.httpClient.get<MessageDto[]>(`${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/pins?${query}`);
    }

    /**
     * Copies an announcement-channel message into every channel currently following it.
     * Gated by PinMessages on the source channel, reused as the elevated-action bit rather
     * than adding a new permission. There is no re-publish guard server-side, so callers
     * must disable the control after a successful publish to avoid duplicate sends.
     */
    public publishMessage(messageId: string): Observable<PublishResponse> {
        return this.httpClient.post<PublishResponse>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/publish`, null);
    }

    /**
     * Removes - or restores - every preview on a message, for everyone who can see it.
     *
     * <p>This is message state, not a per-viewer preference: dismissing a preview dismisses it for
     * the whole channel, which is the point of the feature. Allowed for the author, and for anyone
     * holding `DeleteAnyMessage` in that channel; in a DM, the author only.</p>
     *
     * <p>Restoring re-queues the unfurl rather than returning the old card, so the preview comes
     * back a moment later over `*.MessageUpdated` - never in this response.</p>
     */
    public setEmbedSuppression(messageId: string, suppress: boolean): Observable<EmbedSuppressionResponse> {
        return this.httpClient.patch<EmbedSuppressionResponse>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/messaging/${messageId}/embeds`, {suppress});
    }
}
