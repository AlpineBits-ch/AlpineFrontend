import {computed, inject, Signal} from '@angular/core';
import {catchError, defer, forkJoin, map, Observable, tap, throwError} from 'rxjs';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntities, withEntities} from '@ngrx/signals/entities';
import {
    carriesOccurrence,
    Chore,
    ChoreBalanceEntry,
    ChoreCreated,
    ChoreDeleted,
    ChoreOccurrence,
    ChoreOccurrenceCreated,
    ChoreOccurrenceNudged,
    ChoreOccurrenceUpdated,
    ChoreUpdated,
    CHORE_LIMITS,
} from '../dtos/response/chore.dto';
import {CreateChoreDto, UpdateChoreDto} from '../dtos/request/chore.dto';
import {ChoreApiService, ChoreNudgeResult} from '../services/chore-api.service';
import {ProfileService} from '../services/profile.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';
import {withOptimisticEntities} from './foundation/with-optimistic-entities';

/**
 * How far either side of now the board asks for. Back far enough that a fortnight away still shows
 * what was missed, forward far enough to see next month's deep clean coming.
 */
const WINDOW_BACK_DAYS = 14;
const WINDOW_FORWARD_DAYS = 28;

/**
 * How long completions may pile up before the balance is refetched. The reconcile sweep can emit a
 * burst, and every completion in it moves everyone's delta: the balance is relative to the house
 * average.
 */
const BALANCE_COALESCE_MS = 400;

/** Everything a rendered chores board needs; one of these per Chores channel the user has opened. */
export interface ChoreChannelState {
    chores: readonly Chore[];
    /** The window described by {@link WINDOW_BACK_DAYS}/{@link WINDOW_FORWARD_DAYS}, unsorted. */
    occurrences: readonly ChoreOccurrence[];
    balance: readonly ChoreBalanceEntry[];
    loading: boolean;
    /** Epoch ms of the last successful load. `0` means never, failed, or invalidated. */
    loadedAt: number;
    error: boolean;
    /**
     * The server answered `403`, which usually is not a permission problem at all: every household
     * endpoint is gated on the guild's `Chores` module, and a guild without it answers `403` to
     * everyone including the owner. The UI has to be able to pick between the two sentences.
     */
    forbidden: boolean;
}

const NO_CHORES: readonly Chore[] = Object.freeze([]);
const NO_OCCURRENCES: readonly ChoreOccurrence[] = Object.freeze([]);
const NO_BALANCE: readonly ChoreBalanceEntry[] = Object.freeze([]);

/** Handed out for channels nobody has opened. Shared and frozen: an answer, never a working copy. */
const EMPTY_STATE: ChoreChannelState = Object.freeze({
    chores: NO_CHORES,
    occurrences: NO_OCCURRENCES,
    balance: NO_BALANCE,
    loading: false,
    loadedAt: 0,
    error: false,
    forbidden: false,
});

function sameState(a: ChoreChannelState, b: ChoreChannelState): boolean {
    return (
        a.chores === b.chores &&
        a.occurrences === b.occurrences &&
        a.balance === b.balance &&
        a.loading === b.loading &&
        a.loadedAt === b.loadedAt &&
        a.error === b.error &&
        a.forbidden === b.forbidden
    );
}

/** The two halves of a board fetch that are not occurrences. Handed to the loader as its per-key argument. */
type BoardSides = (channelId: string, chores: Chore[], balance: ChoreBalanceEntry[]) => void;

// The entity writes merge rather than replace, so an omitted stamp would leave the old one standing:
// an un-complete that sends no `completedAt` would read as still done.
function wholeRow(occurrence: ChoreOccurrence): ChoreOccurrence {
    return {
        ...occurrence,
        completedAt: occurrence.completedAt ?? null,
        completedByUserId: occurrence.completedByUserId ?? null,
        skippedAt: occurrence.skippedAt ?? null,
        nudgedAt: occurrence.nudgedAt ?? null,
    };
}

interface ChoreBoardState {
    choresByChannel: Record<string, readonly Chore[]>;
    balanceByChannel: Record<string, readonly ChoreBalanceEntry[]>;
}

/**
 * The contents of every `Chores` channel the user has opened, plus every mutation against them.
 *
 * Keyed by channel because a household has one Chores channel per rota, and household permissions
 * resolve per channel: a role granting control of the kitchen rota grants nothing over the garden one.
 *
 * Occurrences are never synthesized here. There is no client-side cadence arithmetic anywhere in
 * this file: a turn exists because the server generated one and said so over
 * `guild.ChoreOccurrenceCreated`. The only local writes are optimistic echoes of the verbs, each
 * rolled back if its request fails.
 */
export const ChoreStore = signalStore(
    {providedIn: 'root'},
    withEntities<ChoreOccurrence>(),
    withState<ChoreBoardState>({choresByChannel: {}, balanceByChannel: {}}),

    withKeyedIndex<ChoreOccurrence, 'occurrences', BoardSides>({
        collection: 'occurrences',
        // SignalR replays nothing across a reconnect, so a disconnect window leaves a board
        // permanently stale with nothing left to invalidate it. Re-entering past this refetches.
        staleMs: 2 * 60 * 1000,
        fetch: () => {
            const api = inject(ChoreApiService);
            // All three go together: the board is chores by occurrences with the balance panel at
            // its head, so landing them one at a time draws totals that disagree with the rows.
            return (channelId: string, sides?: BoardSides) => {
                const now = Date.now();
                const from = new Date(now - WINDOW_BACK_DAYS * 86_400_000).toISOString();
                const to = new Date(now + WINDOW_FORWARD_DAYS * 86_400_000).toISOString();

                return forkJoin({
                    chores: api.listChores(channelId),
                    occurrences: api.listOccurrences(channelId, from, to),
                    balance: api.balance(channelId, CHORE_LIMITS.balanceDefaultDays),
                }).pipe(
                    tap(({chores, balance}) => sides?.(channelId, chores, balance)),
                    map(({occurrences}) => occurrences.map(wholeRow)),
                );
            };
        },
    }),

    withOptimisticEntities<ChoreOccurrence>(),

    withMethods((store, api = inject(ChoreApiService), profiles = inject(ProfileService)) => {
        const views = new Map<string, Signal<ChoreChannelState>>();
        /** One pending balance refetch per channel; see {@link BALANCE_COALESCE_MS}. */
        const balanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

        const choresOf = (channelId: string): readonly Chore[] =>
            store.choresByChannel()[channelId] ?? NO_CHORES;

        /**
         * A board the user has opened, or one a local write has already put rows on. Not
         * `occurrencesTracked` alone: that is only "a fetch was issued", and a chore created before
         * any load would otherwise leave the channel realtime-deaf.
         */
        const tracked = (channelId: string): boolean =>
            store.occurrencesHeld(channelId) || channelId in store.choresByChannel();

        const putSides: BoardSides = (channelId, chores, balance) => {
            patchState(store, {
                choresByChannel: {...store.choresByChannel(), [channelId]: chores},
                balanceByChannel: {...store.balanceByChannel(), [channelId]: balance},
            });
        };

        const putBalance = (channelId: string, balance: ChoreBalanceEntry[]): void => {
            patchState(store, {balanceByChannel: {...store.balanceByChannel(), [channelId]: balance}});
        };

        const scheduleBalanceRefresh = (channelId: string): void => {
            if (!tracked(channelId)) return;
            if (balanceTimers.has(channelId)) return;
            balanceTimers.set(
                channelId,
                setTimeout(() => {
                    balanceTimers.delete(channelId);
                    api.balance(channelId, CHORE_LIMITS.balanceDefaultDays).subscribe({
                        next: balance => putBalance(channelId, balance),
                        // The panel keeps the numbers it had. A stale balance is a far better answer
                        // than an empty one, and the next load corrects it.
                        error: () => undefined,
                    });
                }, BALANCE_COALESCE_MS),
            );
        };

        /** Upsert by id, keeping list position so a completed row does not jump under the cursor. */
        const putOccurrence = (occurrence: ChoreOccurrence): void => {
            store.attachToOccurrences(occurrence.channelId, wholeRow(occurrence));
        };

        /** The row this board holds, seeded from the caller's copy when the board has never seen it. */
        const heldRow = (occurrence: ChoreOccurrence): ChoreOccurrence => {
            const current = store.entityMap()[occurrence.id];
            if (current) return current;
            putOccurrence(occurrence);
            return occurrence;
        };

        /**
         * `fromResponse` skips the tracking guard: a chore the user just created lands before any
         * realtime echo, and on a channel that is by definition on screen.
         */
        const putChore = (channelId: string, chore: Chore, fromResponse = false): void => {
            if (!fromResponse && !tracked(channelId)) return;
            const current = choresOf(channelId);
            const index = current.findIndex(c => c.id === chore.id);
            patchState(store, {
                choresByChannel: {
                    ...store.choresByChannel(),
                    [channelId]:
                        index === -1 ? [...current, chore] : current.map((c, i) => (i === index ? chore : c)),
                },
            });
        };

        /**
         * Drops the chore and every occurrence it generated. The delete event names only the chore,
         * so the occurrences have to be swept by `choreId`: leaving them would strand rows that can
         * no longer be completed, skipped or swapped.
         */
        const dropChore = (channelId: string, choreId: string): void => {
            if (!tracked(channelId)) return;

            const rows = store.occurrencesFor(channelId)();
            const survivors = rows.filter(row => row.choreId !== choreId);
            const doomed = rows.filter(row => row.choreId === choreId).map(row => row.id);

            patchState(store, {
                choresByChannel: {
                    ...store.choresByChannel(),
                    [channelId]: choresOf(channelId).filter(c => c.id !== choreId),
                },
            });
            store.applyOccurrences(channelId, survivors);
            patchState(store, removeEntities(doomed));
        };

        const failed = (write: {rollback(): void}, err: unknown): Observable<never> => {
            write.rollback();
            return throwError(() => err);
        };

        return {
            /**
             * Never null. A channel nobody has opened reads as the shared frozen default without
             * gaining an entry, so realtime events cannot start applying to a board never fetched.
             */
            stateFor(channelId: string): Signal<ChoreChannelState> {
                const cached = views.get(channelId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const occurrences = store.occurrencesFor(channelId)();
                        const chores = choresOf(channelId);
                        if (!tracked(channelId) && occurrences.length === 0 && chores.length === 0) {
                            return EMPTY_STATE;
                        }

                        const error = store.occurrencesError(channelId);
                        return {
                            chores,
                            occurrences,
                            balance: store.balanceByChannel()[channelId] ?? NO_BALANCE,
                            loading: store.occurrencesLoading(channelId),
                            loadedAt: store.occurrencesLoadedAt(channelId),
                            error: error !== null,
                            forbidden: error === 'forbidden',
                        };
                    },
                    {equal: sameState},
                );

                views.set(channelId, view);
                return view;
            },

            /** Loads, or refreshes, one channel's board. */
            loadFor(channelId: string, force = false): void {
                store.loadOccurrences(channelId, {arg: putSides, force});
            },

            /**
             * Marks every loaded board out of date, so the next open re-reads it.
             *
             * For the one thing that moves occurrences without emitting an occurrence event:
             * declaring an absence hands unfinished chores over in bulk, and the server reports only
             * how many. Guild-wide because this store holds no guild ids, and it deliberately does
             * not refetch: the reassignment usually concerns a board nobody is looking at.
             */
            invalidateAll(): void {
                store.invalidateAllOccurrences();
            },

            // ── Chore definitions ────────────────────────────────────────────

            /**
             * Cold: nothing is sent until the caller subscribes. The realtime echo upserts the same
             * chore a moment later; upserting from the response too means the dialog can close on
             * the response rather than on the socket.
             */
            createChore(channelId: string, dto: CreateChoreDto): Observable<Chore> {
                return api.createChore(channelId, dto).pipe(tap(c => putChore(channelId, c, true)));
            },

            updateChore(channelId: string, choreId: string, dto: UpdateChoreDto): Observable<Chore> {
                return api.updateChore(choreId, dto).pipe(tap(c => putChore(channelId, c, true)));
            },

            /**
             * Pauses or resumes, and touches nothing else. The PATCH body genuinely is one field:
             * re-sending the title and cadence to flip a boolean would overwrite whatever a flatmate
             * changed in between. A paused chore keeps the occurrences it already owes.
             */
            setPaused(channelId: string, choreId: string, isPaused: boolean): Observable<Chore> {
                return api.updateChore(choreId, {isPaused}).pipe(tap(c => putChore(channelId, c, true)));
            },

            deleteChore(channelId: string, choreId: string): Observable<void> {
                return api.deleteChore(choreId).pipe(tap(() => dropChore(channelId, choreId)));
            },

            // ── The verbs ────────────────────────────────────────────────────

            /**
             * Marks a turn done, optimistically. The guess names this user as `completedByUserId`
             * and leaves `assignedUserId` alone, because that is what the server is about to record:
             * doing someone else's turn is supported and the credit still goes to the assignee.
             */
            complete(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
                return defer(() => {
                    const before = heldRow(occurrence);
                    const doerId = profiles.ownProfile()?.userId ?? before.assignedUserId;
                    const write = store.optimistic(before.id, {
                        completedAt: new Date().toISOString(),
                        completedByUserId: doerId,
                        // Done and skipped are mutually exclusive states of one turn.
                        skippedAt: null,
                    });

                    return api.complete(before.id).pipe(
                        tap(fresh => {
                            if (fresh) write.settle(fresh);
                            scheduleBalanceRefresh(before.channelId);
                        }),
                        catchError(err => failed(write, err)),
                    );
                });
            },

            /** The undo for a mis-tap. Withdraws the credit, so the balance is refetched. */
            unComplete(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
                return defer(() => {
                    const before = heldRow(occurrence);
                    const write = store.optimistic(before.id, {
                        completedAt: null,
                        completedByUserId: null,
                    });

                    return api.unComplete(before.id).pipe(
                        tap(fresh => {
                            if (fresh) write.settle(fresh);
                            scheduleBalanceRefresh(before.channelId);
                        }),
                        catchError(err => failed(write, err)),
                    );
                });
            },

            /**
             * Skips a turn, which is not completing it. The completion stamps are cleared so nothing
             * downstream can read the row as done, and the balance is not refetched: a skip credits
             * nobody, the work stays owed, and the rota comes back round to the same person.
             */
            skip(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
                return defer(() => {
                    const before = heldRow(occurrence);
                    const write = store.optimistic(before.id, {
                        skippedAt: new Date().toISOString(),
                        completedAt: null,
                        completedByUserId: null,
                    });

                    return api.skip(before.id).pipe(
                        tap(fresh => {
                            if (fresh) write.settle(fresh);
                        }),
                        catchError(err => failed(write, err)),
                    );
                });
            },

            /**
             * Passes a turn to the lightest-loaded other member of the rotation. Not optimistic: who
             * it lands on is the server's answer, and guessing from a balance we happen to hold
             * would name the wrong flatmate often enough to matter. A swap moves no minutes, so the
             * balance is untouched. `400` means nobody else is in the rotation, and is the caller's
             * to explain.
             */
            swap(occurrence: ChoreOccurrence): Observable<ChoreOccurrence | null> {
                return api.swap(occurrence.id).pipe(
                    tap(fresh => {
                        if (fresh) putOccurrence(fresh);
                    }),
                );
            },

            /**
             * Asks the assignee to get on with an overdue chore. Not optimistic: `nudgedAt` is what
             * greys the button, so stamping it before the server agrees would hide the control on a
             * nudge that was in fact refused, and both refusals worth acting on are `409`s the
             * caller has to read. Nothing here records who sent it, because nothing is told.
             */
            nudge(occurrence: ChoreOccurrence): Observable<ChoreNudgeResult> {
                return api.nudge(occurrence.id).pipe(
                    tap(result => {
                        const current = store.entityMap()[occurrence.id];
                        if (current) putOccurrence({...current, nudgedAt: result.nudgedAt});
                    }),
                );
            },

            // ── Realtime ─────────────────────────────────────────────────────
            //
            // Every handler bails on a channel nobody has opened. Otherwise every chore completed
            // anywhere in the house would accumulate rows for boards nobody is looking at, and
            // opening one later loads it from scratch regardless.

            applyChoreUpserted({channelId, chore}: ChoreCreated | ChoreUpdated): void {
                putChore(channelId, chore);
            },

            applyChoreDeleted({channelId, choreId}: ChoreDeleted): void {
                dropChore(channelId, choreId);
            },

            applyOccurrenceCreated({channelId, occurrence}: ChoreOccurrenceCreated): void {
                if (!tracked(channelId)) return;
                putOccurrence(occurrence);
            },

            /**
             * One shape for all four verbs, a full occurrence every time. {@link carriesOccurrence}
             * is all that remains of the retired bare skip marker, and only keeps a payload from a
             * server that has not rolled forward from throwing inside the SignalR callback.
             */
            applyOccurrenceUpdated(payload: ChoreOccurrenceUpdated): void {
                if (!tracked(payload.channelId)) return;
                if (!carriesOccurrence(payload)) return;

                const previous = store.entityMap()[payload.occurrence.id];
                // Our own echo bumps the generation too, so a verb still in flight for this row is
                // now stale and will not be allowed to overwrite the newer broadcast.
                store.bumpGeneration(payload.occurrence.id);
                putOccurrence(payload.occurrence);

                // Only a change in completion moves minutes. Skip and swap arrive through this same
                // path: a skip credits nobody, and a swap completes nothing.
                if ((previous?.completedAt ?? null) !== (payload.occurrence.completedAt ?? null)) {
                    scheduleBalanceRefresh(payload.channelId);
                }
            },

            /**
             * A stamp, not an occurrence. The one household event carrying a fragment, because a
             * whole row would have to name a sender and there deliberately is not one. So this
             * patches the single field onto whatever is held, and drops the event for a row this
             * board has never seen rather than inventing a blank one out of two fields.
             */
            applyOccurrenceNudged(payload: ChoreOccurrenceNudged): void {
                if (!tracked(payload.channelId)) return;
                const current = store.entityMap()[payload.occurrenceId];
                if (!current) return;
                putOccurrence({...current, nudgedAt: payload.nudgedAt});
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.ChoreCreated').subscribe(e => store.applyChoreUpserted(e));
            realtime.stream('guild.ChoreUpdated').subscribe(e => store.applyChoreUpserted(e));
            realtime.stream('guild.ChoreDeleted').subscribe(e => store.applyChoreDeleted(e));
            realtime.stream('guild.ChoreOccurrenceCreated').subscribe(e => store.applyOccurrenceCreated(e));
            realtime.stream('guild.ChoreOccurrenceUpdated').subscribe(e => store.applyOccurrenceUpdated(e));
            realtime.stream('guild.ChoreOccurrenceNudged').subscribe(e => store.applyOccurrenceNudged(e));
            // The due-date reminder is not registered here. It arrives as `guild.HouseholdAlert`,
            // which covers decisions and bills too, and `HouseholdAlertService` owns its dedupe.
        },
    }),
);
