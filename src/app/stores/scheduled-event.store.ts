import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, updateEntity, upsertEntities, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {catchError, defer, Observable, tap, throwError} from 'rxjs';
import {ScheduledEventService} from '../services/scheduled-event.service';
import {ScheduledEventDto} from '../dtos/response/scheduled-event.dto';
import {CreateScheduledEventDto, UpdateScheduledEventDto} from '../dtos/request/scheduled-event.dto';
import {
    GuildWebsocketService,
    WsEventCancelled,
    WsEventCreated,
    WsEventUpdated,
} from '../services/guild-websocket.service';

// SignalR does not replay messages across a reconnect, so a disconnect window can leave a
// guild's list permanently stale with nothing left to invalidate it. A TTL is the backstop:
// the next panel open past it refetches. Mirrors GuildEmojiStore's STALE_MS, but much
// shorter - events are created/edited far more often than emojis are uploaded.
const STALE_MS = 2 * 60 * 1000;

interface ScheduledEventState {
    loadingGuilds: Record<string, boolean>;
    /** Epoch ms of the last successful load per guild. `0` means explicitly invalidated or failed. */
    loadedAt: Record<string, number>;
    /** Set when a refetch is requested for a guild whose list request is still in flight. */
    pendingRefetch: Record<string, boolean>;
    errorGuilds: Record<string, boolean>;
}

export const ScheduledEventStore = signalStore(
    {providedIn: 'root'},
    withEntities<ScheduledEventDto>(),
    withState<ScheduledEventState>({loadingGuilds: {}, loadedAt: {}, pendingRefetch: {}, errorGuilds: {}}),

    withMethods((store, scheduledEventService = inject(ScheduledEventService)) => {
        /** A guild the user has actually opened at least once (a fetch was issued for it). */
        const isTracked = (guildId: string): boolean =>
            guildId in store.loadedAt() || guildId in store.loadingGuilds();

        /**
         * Issues the follow-up fetch queued by `loadFor` while this request was in flight.
         * Without it, a realtime refetch that races the initial list request would be
         * silently dropped and the newly created event would never appear.
         */
        const drainPendingRefetch = (guildId: string): void => {
            if (!store.pendingRefetch()[guildId]) return;
            patchState(store, {pendingRefetch: {...store.pendingRefetch(), [guildId]: false}});
            fetchList(guildId);
        };

        function fetchList(guildId: string): void {
            patchState(store, {loadingGuilds: {...store.loadingGuilds(), [guildId]: true}});

            scheduledEventService.list(guildId).subscribe({
                next: events => {
                    patchState(store, upsertEntities(events), {
                        loadingGuilds: {...store.loadingGuilds(), [guildId]: false},
                        loadedAt: {...store.loadedAt(), [guildId]: Date.now()},
                        errorGuilds: {...store.errorGuilds(), [guildId]: false},
                    });
                    drainPendingRefetch(guildId);
                },
                error: () => {
                    // `loadedAt: 0` -unlike a success, a failed fetch must never be treated
                    // as "loaded", or a retry would be blocked forever. The error flag lets
                    // the panel distinguish "nothing scheduled" from "the fetch failed".
                    patchState(store, {
                        loadingGuilds: {...store.loadingGuilds(), [guildId]: false},
                        loadedAt: {...store.loadedAt(), [guildId]: 0},
                        errorGuilds: {...store.errorGuilds(), [guildId]: true},
                    });
                    drainPendingRefetch(guildId);
                },
            });
        }

        /** Marks a guild's list stale so the next `loadFor` refetches it. */
        const invalidate = (guildId: string): void => {
            patchState(store, {loadedAt: {...store.loadedAt(), [guildId]: 0}});
        };

        const loadFor = (guildId: string): void => {
            const loadedAt = store.loadedAt()[guildId];
            // Fresh enough - nothing to do. Anything older than STALE_MS (or invalidated /
            // failed, both of which record 0) falls through to a refetch.
            if (loadedAt !== undefined && loadedAt > 0 && Date.now() - loadedAt <= STALE_MS) return;

            if (store.loadingGuilds()[guildId]) {
                // A request is already in flight. Back-to-back opens (loadedAt still
                // undefined) just wait for it. But if the list has since been *invalidated*
                // (loadedAt === 0), the in-flight response is already known to be stale -
                // queue a follow-up rather than dropping the refetch on the floor.
                if (loadedAt === 0) {
                    patchState(store, {pendingRefetch: {...store.pendingRefetch(), [guildId]: true}});
                }
                return;
            }

            fetchList(guildId);
        };

        return {
            eventsForGuild(guildId: string): ScheduledEventDto[] {
                return store
                    .entities()
                    .filter(e => e.guildId === guildId)
                    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
            },

            loading(guildId: string): boolean {
                return store.loadingGuilds()[guildId] ?? false;
            },

            /** True when the most recent list fetch for this guild failed. Cleared by a successful load. */
            loadError(guildId: string): boolean {
                return store.errorGuilds()[guildId] ?? false;
            },

            loadFor,

            create(guildId: string, dto: CreateScheduledEventDto): Observable<ScheduledEventDto> {
                return scheduledEventService
                    .create(guildId, dto)
                    .pipe(tap(created => patchState(store, upsertEntity(created))));
            },

            update(eventId: string, dto: UpdateScheduledEventDto): Observable<ScheduledEventDto> {
                return scheduledEventService
                    .update(eventId, dto)
                    .pipe(tap(updated => patchState(store, upsertEntity(updated))));
            },

            // Soft-cancelled server-side, but the list endpoint excludes cancelled events
            // entirely -so the local copy must be removed, not marked, or a later reload
            // would desync from an in-memory "cancelled" badge that the server never sends.
            // Cold Observable: the entity is only removed - and an error only surfaced -
            // once the caller subscribes, matching create/update so nothing mutates state
            // (or silently drops a failure) without the caller opting in.
            cancel(eventId: string): Observable<void> {
                return scheduledEventService
                    .cancel(eventId)
                    .pipe(tap(() => patchState(store, removeEntity(eventId))));
            },

            // Cold Observable via defer(): the optimistic patch (and the request it guards)
            // only happens on subscribe, and a failure rolls both fields back and is still
            // rethrown to the caller. The pre-call values are read from the store - not from
            // the caller-supplied `event` - inside the defer body, so an overlapping second
            // toggle can't roll back to a value that's already stale by the time this one's
            // request settles.
            toggleInterest(event: ScheduledEventDto): Observable<void> {
                return defer(() => {
                    const current = store.entityMap()[event.id] ?? event;
                    const wasInterested = current.isInterested;
                    const previousCount = current.interestedCount;
                    const nextInterested = !wasInterested;
                    const nextCount = previousCount + (nextInterested ? 1 : -1);

                    patchState(
                        store,
                        updateEntity({
                            id: event.id,
                            changes: {isInterested: nextInterested, interestedCount: nextCount},
                        }),
                    );

                    const request = nextInterested
                        ? scheduledEventService.markInterested(event.id)
                        : scheduledEventService.removeInterest(event.id);

                    return request.pipe(
                        catchError(err => {
                            patchState(
                                store,
                                updateEntity({
                                    id: event.id,
                                    changes: {isInterested: wasInterested, interestedCount: previousCount},
                                }),
                            );
                            return throwError(() => err);
                        }),
                    );
                });
            },

            // The realtime payload only carries {guildId, eventId, title, startsAt} - not
            // enough to build a full ScheduledEventDto (no interestedCount/isInterested).
            // Refetch instead of synthesizing a partial entity.
            //
            // Guilds the user never opened are ignored outright: otherwise every event
            // created anywhere would issue a GET and accumulate entities for a guild nobody
            // is looking at. Opening such a guild later loads it from scratch anyway.
            applyRealtimeCreatedOrUpdated(guildId: string): void {
                if (!isTracked(guildId)) return;
                invalidate(guildId);
                loadFor(guildId);
            },

            applyRealtimeCancelled(eventId: string): void {
                patchState(store, removeEntity(eventId));
            },
        };
    }),

    withHooks({
        onInit(store) {
            const guildWs = inject(GuildWebsocketService);

            guildWs.eventCreatedObservable.subscribe((e: WsEventCreated) =>
                store.applyRealtimeCreatedOrUpdated(e.guildId),
            );

            guildWs.eventUpdatedObservable.subscribe((e: WsEventUpdated) =>
                store.applyRealtimeCreatedOrUpdated(e.guildId),
            );

            guildWs.eventCancelledObservable.subscribe((e: WsEventCancelled) =>
                store.applyRealtimeCancelled(e.eventId),
            );
        },
    }),
);
