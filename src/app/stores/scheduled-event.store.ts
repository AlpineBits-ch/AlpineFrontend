import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, updateEntity, upsertEntities, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {catchError, defer, Observable, tap, throwError} from 'rxjs';
import {ScheduledEventService} from '../services/scheduled-event.service';
import {
    CreateScheduledEventDto,
    ScheduledEventDto,
    UpdateScheduledEventDto,
} from '../dtos/response/scheduled-event.dto';
import {
    GuildWebsocketService,
    WsEventCancelled,
    WsEventCreated,
    WsEventUpdated,
} from '../services/guild-websocket.service';

interface ScheduledEventState {
    loadingGuilds: Record<string, boolean>;
    loadedGuilds: Record<string, boolean>;
}

export const ScheduledEventStore = signalStore(
    {providedIn: 'root'},
    withEntities<ScheduledEventDto>(),
    withState<ScheduledEventState>({loadingGuilds: {}, loadedGuilds: {}}),

    withMethods((store, scheduledEventService = inject(ScheduledEventService)) => {
        const loadFor = (guildId: string): void => {
            // Already loading or loaded -no-op. Mirrors GuildEmojiStore.ensureLoaded's
            // re-entrancy guard so back-to-back calls (or a realtime refetch racing a
            // panel open) don't each fire a request.
            if (store.loadingGuilds()[guildId] || store.loadedGuilds()[guildId]) return;

            patchState(store, {loadingGuilds: {...store.loadingGuilds(), [guildId]: true}});

            scheduledEventService.list(guildId).subscribe({
                next: events => {
                    patchState(store, upsertEntities(events), {
                        loadingGuilds: {...store.loadingGuilds(), [guildId]: false},
                        loadedGuilds: {...store.loadedGuilds(), [guildId]: true},
                    });
                },
                error: () => {
                    // Clear both flags -unlike a success, a failed fetch must not be
                    // treated as "loaded", or a retry would be blocked forever.
                    patchState(store, {
                        loadingGuilds: {...store.loadingGuilds(), [guildId]: false},
                        loadedGuilds: {...store.loadedGuilds(), [guildId]: false},
                    });
                },
            });
        };

        return {
            eventsForGuild(guildId: string): ScheduledEventDto[] {
                return store.entities()
                    .filter(e => e.guildId === guildId)
                    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
            },

            loading(guildId: string): boolean {
                return store.loadingGuilds()[guildId] ?? false;
            },

            loadFor,

            create(guildId: string, dto: CreateScheduledEventDto): Observable<ScheduledEventDto> {
                return scheduledEventService.create(guildId, dto).pipe(
                    tap(created => patchState(store, upsertEntity(created))),
                );
            },

            update(eventId: string, dto: UpdateScheduledEventDto): Observable<ScheduledEventDto> {
                return scheduledEventService.update(eventId, dto).pipe(
                    tap(updated => patchState(store, upsertEntity(updated))),
                );
            },

            // Soft-cancelled server-side, but the list endpoint excludes cancelled events
            // entirely -so the local copy must be removed, not marked, or a later reload
            // would desync from an in-memory "cancelled" badge that the server never sends.
            // Cold Observable: the entity is only removed - and an error only surfaced -
            // once the caller subscribes, matching create/update so nothing mutates state
            // (or silently drops a failure) without the caller opting in.
            cancel(eventId: string): Observable<void> {
                return scheduledEventService.cancel(eventId).pipe(
                    tap(() => patchState(store, removeEntity(eventId))),
                );
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

                    patchState(store, updateEntity({
                        id: event.id,
                        changes: {isInterested: nextInterested, interestedCount: nextCount},
                    }));

                    const request = nextInterested
                        ? scheduledEventService.markInterested(event.id)
                        : scheduledEventService.removeInterest(event.id);

                    return request.pipe(
                        catchError(err => {
                            patchState(store, updateEntity({
                                id: event.id,
                                changes: {isInterested: wasInterested, interestedCount: previousCount},
                            }));
                            return throwError(() => err);
                        }),
                    );
                });
            },

            // The realtime payload only carries {guildId, eventId, title, startsAt} - not
            // enough to build a full ScheduledEventDto (no interestedCount/isInterested).
            // Refetch instead of synthesizing a partial entity.
            applyRealtimeCreatedOrUpdated(guildId: string): void {
                patchState(store, {loadedGuilds: {...store.loadedGuilds(), [guildId]: false}});
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
                store.applyRealtimeCreatedOrUpdated(e.guildId));

            guildWs.eventUpdatedObservable.subscribe((e: WsEventUpdated) =>
                store.applyRealtimeCreatedOrUpdated(e.guildId));

            guildWs.eventCancelledObservable.subscribe((e: WsEventCancelled) =>
                store.applyRealtimeCancelled(e.eventId));
        },
    }),
);
