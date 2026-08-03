import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {
    Decision,
    DecisionCancelled,
    DecisionClosed,
    DecisionCreated,
    DecisionStatus,
    DecisionUpdated,
} from '../dtos/response/decision.dto';
import {CreateDecisionDto, DecisionVoteDto} from '../dtos/request/decision.dto';
import {DecisionApiService} from './decision-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * How long a channel's list is trusted before the next open refetches it.
 *
 * <p>SignalR replays nothing across a reconnect, so a socket that dropped for a minute leaves
 * a list permanently stale with nothing left to invalidate it. Same backstop, and roughly the
 * same window, as {@link import('../stores/scheduled-event.store').ScheduledEventStore}.</p>
 */
const STALE_MS = 2 * 60 * 1000;

/**
 * Why a channel's list is empty.
 *
 * <p>`forbidden` is deliberately not called "no permission": a `403` from any household
 * endpoint often means the guild does not have the module at all. The caller checks `features`
 * first and only ever reaches this for the genuinely ambiguous case.</p>
 */
export type DecisionLoadError = 'forbidden' | 'failed' | null;

export interface ChannelDecisionState {
    decisions: Decision[];
    loading: boolean;
    /** Epoch ms of the last successful load. `0` means never loaded, invalidated, or failed. */
    loadedAt: number;
    error: DecisionLoadError;
}

const EMPTY: ChannelDecisionState = {decisions: [], loading: false, loadedAt: 0, error: null};

/**
 * Every decision the client knows about, keyed by the channel it lives in.
 *
 * <p>Writes go through the API and come back as a whole `Decision`, so nothing here merges
 * fields - the server's copy replaces ours. That matters more than usual for this module:
 * `isBlocked` and `outcomeOptionId` are the server's conclusions about who blocked what, and a
 * client that recomputed either of them locally would eventually disagree with the house.</p>
 *
 * <p>No optimism on votes, for the same reason. A support that the server turns into a block
 * being cleared, or a vote that races another member's block, would flash a carried option that
 * is in fact out - and "your objection was briefly ignored" is the one failure this module
 * cannot afford.</p>
 */
@Injectable({providedIn: 'root'})
export class DecisionService {
    private api = inject(DecisionApiService);
    private realtime = inject(RealtimeConnectionService);

    private state = signal<Record<string, ChannelDecisionState>>({});

    constructor() {
        // Registered once, in the constructor of a root singleton: `RealtimeConnectionService.on`
        // does not deduplicate, so a second registration delivers every event twice - which here
        // would double-count nothing but would resurrect a cancelled decision. `on` is safe
        // before `start`; early handlers are replayed onto the connection when it is built.
        this.realtime.on('guild.DecisionCreated', (d: DecisionCreated) => this.onUpserted(d));
        this.realtime.on('guild.DecisionUpdated', (d: DecisionUpdated) => this.onUpserted(d));
        this.realtime.on('guild.DecisionClosed', (d: DecisionClosed) => this.onUpserted(d));
        this.realtime.on('guild.DecisionCancelled', (d: DecisionCancelled) => this.onCancelled(d));
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /**
     * One channel's list. Untracked channels read as {@link EMPTY}, never undefined.
     *
     * <p>Reads the state signal, so calling it inside a `computed` makes that computed track
     * this service - which is how the component stays reactive without every caller holding a
     * per-channel signal.</p>
     */
    stateFor(channelId: string): ChannelDecisionState {
        return this.state()[channelId] ?? EMPTY;
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /**
     * Fetches the channel's decisions unless a fresh copy is already in hand.
     *
     * @param force skips the freshness check - the retry button, and nothing else.
     */
    async loadFor(channelId: string, force = false): Promise<void> {
        const current = this.state()[channelId] ?? EMPTY;
        if (current.loading) return;
        if (!force && current.loadedAt > 0 && Date.now() - current.loadedAt <= STALE_MS) return;

        this.patch(channelId, {loading: true, error: null});
        try {
            const decisions = await firstValueFrom(this.api.list(channelId));
            this.patch(channelId, {decisions, loading: false, loadedAt: Date.now(), error: null});
        } catch (err) {
            // `loadedAt: 0` - a failed fetch must never be treated as loaded, or the retry is
            // blocked by its own freshness check forever.
            this.patch(channelId, {loading: false, loadedAt: 0, error: classify(err)});
        }
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    /** Needs `CreateDecisions`. The created decision is merged in; the broadcast is a no-op after it. */
    async create(channelId: string, dto: CreateDecisionDto): Promise<Decision> {
        const created = await firstValueFrom(this.api.create(channelId, dto));
        this.upsert(channelId, created);
        return created;
    }

    /**
     * Casts or replaces the caller's vote. Needs `VoteDecisions`.
     *
     * <p>The response is the recomputed decision - new `supportCount`s, a possibly new
     * `isBlocked`, possibly a resolved status if that vote met quorum. It replaces wholesale.</p>
     */
    async vote(channelId: string, decisionId: string, dto: DecisionVoteDto): Promise<Decision> {
        const updated = await firstValueFrom(this.api.vote(decisionId, dto));
        this.upsert(channelId, updated);
        return updated;
    }

    /** Needs `CreateDecisions`. The outcome is the server's to compute, not ours to predict. */
    async close(channelId: string, decisionId: string): Promise<Decision> {
        const closed = await firstValueFrom(this.api.close(decisionId));
        this.upsert(channelId, closed);
        return closed;
    }

    /** Needs `CreateDecisions`. Soft: the row stays, with {@link DecisionStatus.Cancelled}. */
    async cancel(channelId: string, decisionId: string): Promise<void> {
        await firstValueFrom(this.api.cancel(decisionId));
        this.markCancelled(channelId, decisionId);
    }

    // ── Realtime ────────────────────────────────────────────────────────────

    /**
     * Created, updated and closed all carry the whole DTO, so one handler covers them.
     *
     * <p>Only channels the client has actually loaded are touched. Seeding a list from an event
     * would leave a channel holding exactly the one decision that happened to change while the
     * user was elsewhere, and `loadFor` would then consider it loaded.</p>
     */
    private onUpserted(event: DecisionCreated | DecisionUpdated | DecisionClosed): void {
        if (!this.isTracked(event.channelId)) return;
        this.upsert(event.channelId, event.decision);
    }

    /**
     * The cancel broadcast carries no decision, only its id - so there is nothing to replace the
     * local copy with, and the status transition is applied to what we already hold.
     */
    private onCancelled(event: DecisionCancelled): void {
        if (!this.isTracked(event.channelId)) return;
        this.markCancelled(event.channelId, event.decisionId);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private isTracked(channelId: string): boolean {
        return channelId in this.state();
    }

    private upsert(channelId: string, decision: Decision): void {
        const current = this.state()[channelId] ?? EMPTY;
        const index = current.decisions.findIndex(d => d.id === decision.id);
        const decisions = index === -1
            ? [decision, ...current.decisions]
            : current.decisions.map((d, i) => i === index ? decision : d);
        this.patch(channelId, {decisions});
    }

    private markCancelled(channelId: string, decisionId: string): void {
        const current = this.state()[channelId] ?? EMPTY;
        if (!current.decisions.some(d => d.id === decisionId)) return;
        this.patch(channelId, {
            decisions: current.decisions.map(d =>
                d.id === decisionId ? {...d, status: DecisionStatus.Cancelled} : d),
        });
    }

    private patch(channelId: string, changes: Partial<ChannelDecisionState>): void {
        this.state.update(all => ({
            ...all,
            [channelId]: {...(all[channelId] ?? EMPTY), ...changes},
        }));
    }
}

/** A `403` is worth its own copy; everything else is one "couldn't load" with a retry. */
function classify(err: unknown): DecisionLoadError {
    return err instanceof HttpErrorResponse && err.status === 403 ? 'forbidden' : 'failed';
}
