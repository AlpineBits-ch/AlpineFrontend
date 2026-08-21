import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {Chore, ChoreOccurrence} from '../dtos/response/chore.dto';
import {CreateChoreDto, UpdateChoreDto} from '../dtos/request/chore.dto';
import {ChoreChannelState, ChoreStore} from '../stores/chore.store';
import {ChoreNudgeResult} from './chore-api.service';

export type {ChoreChannelState};

/** The view-facing shape of {@link ChoreStore}. State, optimism and realtime all live in the store. */
@Injectable({providedIn: 'root'})
export class ChoreService {
    private store = inject(ChoreStore);

    // ── Reads ───────────────────────────────────────────────────────────────

    /** Reactive: reads the backing signal, so a `computed` over this re-runs on any change. */
    stateFor(channelId: string): ChoreChannelState {
        return this.store.stateFor(channelId)();
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /** Loads (or refreshes) one channel's board: chores, occurrences and balance together. */
    loadFor(channelId: string, force = false): void {
        this.store.loadFor(channelId, force);
    }

    /** Marks every loaded board out of date, so the next open re-reads it. */
    invalidateAll(): void {
        this.store.invalidateAll();
    }

    // ── Chore definitions ───────────────────────────────────────────────────

    createChore(channelId: string, dto: CreateChoreDto): Observable<Chore> {
        return this.store.createChore(channelId, dto);
    }

    updateChore(channelId: string, choreId: string, dto: UpdateChoreDto): Observable<Chore> {
        return this.store.updateChore(channelId, choreId, dto);
    }

    /** Pauses or resumes a chore, and touches nothing else. */
    setPaused(channelId: string, choreId: string, isPaused: boolean): Observable<Chore> {
        return this.store.setPaused(channelId, choreId, isPaused);
    }

    deleteChore(channelId: string, choreId: string): Observable<void> {
        return this.store.deleteChore(channelId, choreId);
    }

    // ── The verbs ───────────────────────────────────────────────────────────

    /** Marks a turn done, optimistically. The credit stays with the assignee. */
    complete(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return this.store.complete(occurrence);
    }

    /** The undo for a mis-tap. Withdraws the credit, so the balance is refetched. */
    unComplete(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return this.store.unComplete(occurrence);
    }

    /** Skips a turn, which is not completing it. Nothing is credited and the work stays owed. */
    skip(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return this.store.skip(occurrence);
    }

    /** Passes a turn to the lightest-loaded other member. `400` means nobody else is in the rotation. */
    swap(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
        return this.store.swap(occurrence);
    }

    /** Asks the assignee to get on with an overdue chore. Two `409` refusals the caller must tell apart. */
    nudge(occurrence: ChoreOccurrence): Observable<ChoreNudgeResult> {
        return this.store.nudge(occurrence);
    }
}
