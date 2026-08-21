import {inject, Injectable} from '@angular/core';
import {Decision} from '../dtos/response/decision.dto';
import {CreateDecisionDto, DecisionVoteDto} from '../dtos/request/decision.dto';
import {ChannelDecisionState, DecisionLoadError, DecisionStore} from '../stores/decision.store';

export type {ChannelDecisionState, DecisionLoadError};

/** The view-facing shape of {@link DecisionStore}. State and realtime both live in the store. */
@Injectable({providedIn: 'root'})
export class DecisionService {
    private store = inject(DecisionStore);

    // ── Reads ───────────────────────────────────────────────────────────────

    /**
     * One channel's list. Untracked channels read as an empty state, never undefined.
     *
     * Reads a signal, so calling it inside a `computed` makes that computed track this service.
     */
    stateFor(channelId: string): ChannelDecisionState {
        return this.store.stateFor(channelId)();
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /**
     * Fetches the channel's decisions unless a fresh copy is already in hand.
     *
     * @param force skips the freshness check: the retry button, and nothing else.
     */
    async loadFor(channelId: string, force = false): Promise<void> {
        this.store.loadFor(channelId, force);
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    /** Needs `CreateDecisions`. The created decision is merged in; the broadcast is a no-op after it. */
    create(channelId: string, dto: CreateDecisionDto): Promise<Decision> {
        return this.store.create(channelId, dto);
    }

    /**
     * Casts or replaces the caller's vote. Needs `VoteDecisions`.
     *
     * The response is the recomputed decision: new `supportCount`s, a possibly new `isBlocked`,
     * possibly a resolved status if that vote met quorum. It replaces wholesale.
     */
    vote(channelId: string, decisionId: string, dto: DecisionVoteDto): Promise<Decision> {
        return this.store.vote(channelId, decisionId, dto);
    }

    /** Needs `CreateDecisions`. The outcome is the server's to compute, not ours to predict. */
    close(channelId: string, decisionId: string): Promise<Decision> {
        return this.store.close(channelId, decisionId);
    }

    /** Needs `CreateDecisions`. Soft: the row stays, with `DecisionStatus.Cancelled`. */
    cancel(channelId: string, decisionId: string): Promise<void> {
        return this.store.cancel(channelId, decisionId);
    }
}
