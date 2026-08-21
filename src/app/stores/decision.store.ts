import {computed, inject, Signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {patchState, signalStore, withHooks, withMethods} from '@ngrx/signals';
import {updateEntity, withEntities} from '@ngrx/signals/entities';
import {
    Decision,
    DecisionCancelled,
    DecisionClosed,
    DecisionCreated,
    DecisionStatus,
    DecisionUpdated,
} from '../dtos/response/decision.dto';
import {CreateDecisionDto, DecisionVoteDto} from '../dtos/request/decision.dto';
import {DecisionApiService} from '../services/decision-api.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';

/**
 * Why a channel's list is empty.
 *
 * `forbidden` is not "no permission": a `403` from any household endpoint often means the guild
 * does not have the module at all. The caller checks `features` first and only ever reaches this
 * for the genuinely ambiguous case.
 */
export type DecisionLoadError = 'forbidden' | 'failed' | null;

export interface ChannelDecisionState {
    decisions: Decision[];
    loading: boolean;
    /** Epoch ms of the last successful load. `0` means never loaded, invalidated, or failed. */
    loadedAt: number;
    error: DecisionLoadError;
}

/** Handed out for channels nobody has opened. */
const EMPTY: ChannelDecisionState = {decisions: [], loading: false, loadedAt: 0, error: null};

function sameState(a: ChannelDecisionState, b: ChannelDecisionState): boolean {
    return (
        a.decisions === b.decisions &&
        a.loading === b.loading &&
        a.loadedAt === b.loadedAt &&
        a.error === b.error
    );
}

/**
 * Every decision the client knows about, keyed by the channel it lives in.
 *
 * Writes go through the API and come back as a whole `Decision`, so nothing here merges fields:
 * the server's copy replaces ours. That matters more than usual for this module. `isBlocked` and
 * `outcomeOptionId` are the server's conclusions about who blocked what, and a client that
 * recomputed either of them locally would eventually disagree with the house.
 *
 * No optimism on votes, for the same reason. A support that the server turns into a block being
 * cleared, or a vote that races another member's block, would flash a carried option that is in
 * fact out, and "your objection was briefly ignored" is the one failure this module cannot afford.
 */
export const DecisionStore = signalStore(
    {providedIn: 'root'},
    withEntities<Decision>(),

    withKeyedIndex<Decision, 'decisions'>({
        collection: 'decisions',
        // SignalR replays nothing across a reconnect, so a socket that dropped for a minute leaves
        // a list permanently stale with nothing left to invalidate it.
        staleMs: 2 * 60 * 1000,
        fetch: () => {
            const api = inject(DecisionApiService);
            return (channelId: string) => api.list(channelId);
        },
    }),

    withMethods((store, api = inject(DecisionApiService)) => {
        const views = new Map<string, Signal<ChannelDecisionState>>();

        const rowsOf = (channelId: string): Decision[] => store.decisionsFor(channelId)();

        /** Newest first, and an existing row is replaced where it stands. */
        const upsert = (channelId: string, decision: Decision): void => {
            const rows = rowsOf(channelId);
            const index = rows.findIndex(row => row.id === decision.id);
            store.applyDecisions(
                channelId,
                index === -1 ? [decision, ...rows] : rows.map((row, i) => (i === index ? decision : row)),
            );
        };

        const markCancelled = (channelId: string, decisionId: string): void => {
            if (!rowsOf(channelId).some(row => row.id === decisionId)) return;
            patchState(store, updateEntity({id: decisionId, changes: {status: DecisionStatus.Cancelled}}));
        };

        return {
            /** Never null. A channel nobody has opened reads as {@link EMPTY}. */
            stateFor(channelId: string): Signal<ChannelDecisionState> {
                const cached = views.get(channelId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const decisions = rowsOf(channelId);
                        if (!store.decisionsHeld(channelId)) return EMPTY;
                        return {
                            decisions,
                            loading: store.decisionsLoading(channelId),
                            loadedAt: store.decisionsLoadedAt(channelId),
                            error: store.decisionsError(channelId),
                        };
                    },
                    {equal: sameState},
                );

                views.set(channelId, view);
                return view;
            },

            /** Fetches the channel's decisions unless a fresh copy is already in hand. */
            loadFor(channelId: string, force: boolean): void {
                store.loadDecisions(channelId, {force});
            },

            async create(channelId: string, dto: CreateDecisionDto): Promise<Decision> {
                const created = await firstValueFrom(api.create(channelId, dto));
                upsert(channelId, created);
                return created;
            },

            async vote(channelId: string, decisionId: string, dto: DecisionVoteDto): Promise<Decision> {
                const updated = await firstValueFrom(api.vote(decisionId, dto));
                upsert(channelId, updated);
                return updated;
            },

            async close(channelId: string, decisionId: string): Promise<Decision> {
                const closed = await firstValueFrom(api.close(decisionId));
                upsert(channelId, closed);
                return closed;
            },

            async cancel(channelId: string, decisionId: string): Promise<void> {
                await firstValueFrom(api.cancel(decisionId));
                markCancelled(channelId, decisionId);
            },

            // ── Realtime ─────────────────────────────────────────────────────
            //
            // Only channels the client has actually loaded are touched. Seeding a list from an
            // event would leave a channel holding exactly the one decision that changed while the
            // user was elsewhere, and `loadFor` would then consider it loaded.

            /** Created, updated and closed all carry the whole DTO, so one handler covers them. */
            applyUpserted(event: DecisionCreated | DecisionUpdated | DecisionClosed): void {
                if (!store.decisionsHeld(event.channelId)) return;
                upsert(event.channelId, event.decision);
            },

            // The cancel broadcast carries no decision, only its id, so the status transition is
            // applied to what we already hold.
            applyCancelled(event: DecisionCancelled): void {
                if (!store.decisionsHeld(event.channelId)) return;
                markCancelled(event.channelId, event.decisionId);
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.DecisionCreated').subscribe(e => store.applyUpserted(e));
            realtime.stream('guild.DecisionUpdated').subscribe(e => store.applyUpserted(e));
            realtime.stream('guild.DecisionClosed').subscribe(e => store.applyUpserted(e));
            realtime.stream('guild.DecisionCancelled').subscribe(e => store.applyCancelled(e));
        },
    }),
);
