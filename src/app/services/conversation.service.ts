import {inject, Injectable} from '@angular/core';
import {CreateConversationDto} from '../dtos/request/create-conversation.dto';
import {catchError, map, Observable, of, throwError} from 'rxjs';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {MlsDeviceTokenDto} from '../dtos/response/mls-device-token.dto';
import {ApiConfigService} from './api-config.service';

/** Outcome of a create call. `existing` means the server matched an equivalent conversation and made nothing. */
export interface CreateConversationResult {
    conversation: ConversationDto;
    existing: boolean;
}

@Injectable({
    providedIn: 'root',
})
export class ConversationService {
    private httpClient = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    /**
     * Creates a conversation, or hands back the equivalent one that already exists.
     *
     * The server answers an equivalent conversation with 302 and no Location header, so XHR cannot
     * follow it and Angular reports it as a failure. The body is the conversation either way.
     */
    public createConversation(
        createConversationDto: CreateConversationDto,
    ): Observable<CreateConversationResult> {
        return this.httpClient
            .post<ConversationDto>(
                this.apiConfig.baseUrl() + '/api/v1/messaging/conversations',
                createConversationDto,
            )
            .pipe(
                map(conversation => ({conversation, existing: false})),
                catchError((err: unknown) => {
                    const conversation =
                        err instanceof HttpErrorResponse && err.status === 302
                            ? redirectedConversation(err.error)
                            : null;
                    return conversation ? of({conversation, existing: true}) : throwError(() => err);
                }),
            );
    }

    // The un-scoped `GET /conversations/welcomes` is deliberately not exposed here. It selected the
    // legacy contract, where the server matched on user alone and consumed on read - so one device
    // could burn the single-use init key of a Welcome addressed to a *different* device of the same
    // user, which then never saw it again and stayed permanently outside that group. The route
    // still exists for clients in the field (contract §I.3); this client uses the device-scoped
    // `MlsTransportService.getPendingWelcomes` only.

    public getConversations(offset: number, limit: number): Observable<ConversationDto[]> {
        return this.httpClient.get<ConversationDto[]>(
            this.apiConfig.baseUrl() + `/api/v1/messaging/conversations?offset=${offset}&limit=${limit}`,
        );
    }

    public getConversationById(id: string): Observable<ConversationDto> {
        return this.httpClient.get<ConversationDto>(
            this.apiConfig.baseUrl() + `/api/v1/messaging/conversations/${id}`,
        );
    }

    /**
     * Adds someone to an existing group conversation.
     *
     * Roster only. For an encrypted conversation their devices still have to be admitted to the MLS
     * group, which only a member's client can do - see {@link ConversationMemberService.addMember}
     * for the pairing.
     */
    public addMember(conversationId: string, userId: string): Observable<ConversationDto> {
        return this.httpClient.post<ConversationDto>(
            `${this.apiConfig.baseUrl()}/api/v1/messaging/conversations/${conversationId}/members`,
            {userId},
        );
    }

    public deleteConversation(id: string): Observable<void> {
        return this.httpClient.delete<void>(
            this.apiConfig.baseUrl() + `/api/v1/messaging/conversations/${id}`,
        );
    }

    public getMlsTokensForUserIds(ids: string[]): Observable<{deviceTokens: MlsDeviceTokenDto[]}> {
        return this.httpClient.post<{
            deviceTokens: MlsDeviceTokenDto[];
        }>(this.apiConfig.baseUrl() + '/api/v1/messaging/conversations/consume-tokens', {
            userIds: ids,
        });
    }
}

/** The conversation carried by a 302 body, or null when the body is not one. */
function redirectedConversation(body: unknown): ConversationDto | null {
    // A native HTTP stack can leave the body as text where XHR would have parsed it.
    const parsed = typeof body === 'string' ? tryParse(body) : body;
    return isConversation(parsed) ? parsed : null;
}

function tryParse(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function isConversation(body: unknown): body is ConversationDto {
    return typeof body === 'object' && body !== null && typeof (body as ConversationDto).id === 'string';
}
