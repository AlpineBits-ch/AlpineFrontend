import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, updateEntity, upsertEntities, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {Observable, tap} from 'rxjs';
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
            cancel(eventId: string): void {
                scheduledEventService.cancel(eventId).subscribe({
                    next: () => patchState(store, removeEntity(eventId)),
                });
            },

            toggleInterest(event: ScheduledEventDto): void {
                const wasInterested = event.isInterested;
                const previousCount = event.interestedCount;
                const nextInterested = !wasInterested;
                const nextCount = previousCount + (nextInterested ? 1 : -1);

                patchState(store, updateEntity({
                    id: event.id,
                    changes: {isInterested: nextInterested, interestedCount: nextCount},
                }));

                const request = nextInterested
                    ? scheduledEventService.markInterested(event.id)
                    : scheduledEventService.removeInterest(event.id);

                request.subscribe({
                    error: () => {
                        patchState(store, updateEntity({
                            id: event.id,
                            changes: {isInterested: wasInterested, interestedCount: previousCount},
                        }));
                    },
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
