import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {map, Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {Decision, normalizeDecision} from '../dtos/response/decision.dto';
import {CreateDecisionDto, DecisionVoteDto} from '../dtos/request/decision.dto';

/**
 * The decisions HTTP surface, and nothing else. State, optimism and realtime reconciliation
 * live in {@link import('./decision.service').DecisionService}.
 *
 * <p>Two path shapes, both correct: the list lives under its channel, but a decision is
 * addressed by id alone once it exists. The doubled `guild` segment is the gateway's - it
 * strips one before forwarding.</p>
 */
@Injectable({providedIn: 'root'})
export class DecisionApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /**
     * Every decision in the channel, open and resolved.
     *
     * <p>`403` here is ambiguous by design: it is either "you can't see this channel" or "this
     * guild doesn't have the Decisions module". Callers must read `features` before rendering
     * rather than translating the status straight into a permission message.</p>
     */
    list(channelId: string): Observable<Decision[]> {
        return this.http
            .get<Decision[]>(`${this.base}/channels/${channelId}/decisions`)
            .pipe(map(rows => (rows ?? []).map(normalizeDecision)));
    }

    /** Needs `CreateDecisions` on the channel. */
    create(channelId: string, dto: CreateDecisionDto): Observable<Decision> {
        return this.http
            .post<Decision>(`${this.base}/channels/${channelId}/decisions`, dto)
            .pipe(map(normalizeDecision));
    }

    /**
     * Casts or replaces the caller's vote. Needs `VoteDecisions`.
     *
     * <p>`PUT`, and an upsert server-side: there is one vote per member, so this is "change my
     * vote", not a second ballot. `400` when a Support carries no `optionId` or a Block carries
     * no `reason` - see `voteBodyProblem`, which the form checks first.</p>
     */
    vote(decisionId: string, dto: DecisionVoteDto): Observable<Decision> {
        return this.http
            .put<Decision>(`${this.base}/decisions/${decisionId}/vote`, dto)
            .pipe(map(normalizeDecision));
    }

    /**
     * Resolves the decision now rather than waiting for `closesAt`. Needs `CreateDecisions`.
     *
     * <p>The server decides the outcome, not the caller: closing a decision every option of
     * which was blocked yields `Blocked`, not a winner.</p>
     */
    close(decisionId: string): Observable<Decision> {
        return this.http
            .post<Decision>(`${this.base}/decisions/${decisionId}/close`, null)
            .pipe(map(normalizeDecision));
    }

    /**
     * Soft-cancel. Needs `CreateDecisions`.
     *
     * <p>Returns no body, and the `guild.DecisionCancelled` broadcast carries only an id - so
     * neither path hands back a decision to replace the local copy with.</p>
     */
    cancel(decisionId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/decisions/${decisionId}`);
    }
}
