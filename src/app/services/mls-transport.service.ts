import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    AckWelcomesResultDto,
    ConsumeTokensResultDto,
    EnableMlsDto,
    MlsCommitDto,
    MlsCommitPublishedDto,
    MlsContextStateDto,
    MlsCoverageDto,
    MlsToggleResultDto,
    PendingWelcomeDto,
    PublishMlsCommitDto,
} from '../dtos/mls.dto';

/**
 * Thin HTTP layer over the server's MLS transport. No orchestration lives here - see
 * {@link MlsSyncService} for the ordering and retry rules that make these calls safe to use.
 *
 * Conversations and channels have separate routes because their authorization differs (membership
 * versus channel permissions), but the payloads are identical, so each pair collapses to one method
 * taking the base path.
 */
@Injectable({providedIn: 'root'})
export class MlsTransportService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/messaging`;
    }

    private contextBase(contextId: string, isChannel: boolean): string {
        return isChannel
            ? `${this.base}/channels/${encodeURIComponent(contextId)}/mls`
            : `${this.base}/conversations/${encodeURIComponent(contextId)}/mls`;
    }

    // -------------------------------------------------------------------------
    // Commits
    // -------------------------------------------------------------------------

    /**
     * Every commit above `sinceEpoch`, in epoch order.
     *
     * This is the *only* way group state should advance. The realtime push carries no commit bytes
     * precisely so that clients cannot apply them in delivery order - an MLS client that applies
     * commits out of order is forked off the group for good.
     */
    getCommits(
        contextId: string,
        isChannel: boolean,
        sinceEpoch: number,
        generation?: number,
    ): Observable<MlsCommitDto[]> {
        let params = new HttpParams().set('sinceEpoch', sinceEpoch);
        if (generation !== undefined) params = params.set('generation', generation);

        return this.http.get<MlsCommitDto[]>(`${this.contextBase(contextId, isChannel)}/commits`, {params});
    }

    /**
     * Publishes a commit. Rejected with 409 when the epoch is not exactly one past the group's, or
     * when the generation has moved on - {@link MlsSyncService} is what turns that into a catch-up
     * and a retry.
     */
    publishCommit(
        contextId: string,
        isChannel: boolean,
        dto: PublishMlsCommitDto,
    ): Observable<MlsCommitPublishedDto> {
        return this.http.post<MlsCommitPublishedDto>(`${this.contextBase(contextId, isChannel)}/commits`, dto);
    }

    // -------------------------------------------------------------------------
    // Context state
    // -------------------------------------------------------------------------

    getState(contextId: string, isChannel: boolean): Observable<MlsContextStateDto> {
        return this.http.get<MlsContextStateDto>(`${this.contextBase(contextId, isChannel)}/state`);
    }

    /**
     * Which devices can read the context, for the caller's account and for everyone else's.
     *
     * Reports only - the server holds no group keys and cannot add anyone. See
     * {@link MlsCoverageService} for the caching and the local cross-check that decide what any of
     * this is allowed to claim.
     */
    getCoverage(contextId: string, isChannel: boolean): Observable<MlsCoverageDto> {
        return this.http.get<MlsCoverageDto>(`${this.contextBase(contextId, isChannel)}/coverage`);
    }

    /** Turns encryption on for a channel. Requires ManageChannel server-side. */
    enableChannelEncryption(channelId: string, dto: EnableMlsDto): Observable<MlsToggleResultDto> {
        return this.http.post<MlsToggleResultDto>(`${this.contextBase(channelId, true)}/enable`, dto);
    }

    /**
     * Turns encryption off for a channel. Nothing is decrypted - the response names the terminated
     * generation so the UI can say which stretch of history stays readable only on devices that
     * already hold its keys.
     */
    disableChannelEncryption(channelId: string): Observable<MlsToggleResultDto> {
        return this.http.post<MlsToggleResultDto>(`${this.contextBase(channelId, true)}/disable`, null);
    }

    // -------------------------------------------------------------------------
    // Welcomes
    // -------------------------------------------------------------------------

    /**
     * Welcomes waiting for *this* device, across every context.
     *
     * `deviceId` is what makes the read non-destructive. Omitting it selects the legacy contract,
     * where the server consumes on read - which loses the single-use init key whenever the join
     * afterwards fails, locking this device out of that context permanently.
     */
    getPendingWelcomes(deviceId: string): Observable<PendingWelcomeDto[]> {
        return this.http.get<PendingWelcomeDto[]>(
            `${this.base}/conversations/welcomes`,
            {params: new HttpParams().set('deviceId', deviceId)},
        );
    }

    /**
     * Marks Welcomes consumed - only after the join actually succeeded.
     *
     * `deviceId` scopes the ack to this device's own leaves. Scoped by user alone, one device could
     * acknowledge a Welcome addressed to another's leaf: bytes it cannot use, and which the owning
     * device then never sees again, leaving that device permanently outside the group with nothing
     * to indicate why.
     */
    ackWelcomes(welcomeIds: string[], deviceId: string): Observable<AckWelcomesResultDto> {
        return this.http.post<AckWelcomesResultDto>(
            `${this.base}/conversations/welcomes/ack`,
            {welcomeIds, deviceId},
        );
    }

    // -------------------------------------------------------------------------
    // Key packages
    // -------------------------------------------------------------------------

    /** Consumes one key package per device of each listed user, to add them to a group. */
    consumeTokensForUsers(userIds: string[]): Observable<ConsumeTokensResultDto> {
        return this.http.post<ConsumeTokensResultDto>(
            `${this.base}/conversations/consume-tokens`,
            {userIds},
        );
    }
}
