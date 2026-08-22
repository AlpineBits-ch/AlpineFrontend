import {inject} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, defer, Observable, of, tap, throwError} from 'rxjs';
import {patchState, signalStore, type, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, updateEntity, withEntities} from '@ngrx/signals/entities';
import {
    DiscoveryCardDto,
    DiscoveryFeedDto,
    InterestsDto,
    ListingDto,
    WsInterestsChanged,
    WsListingChanged,
    WsListingSuspended,
} from '../dtos/response/discovery.dto';
import {DiscoveryFeedQuery, ListingWriteDto, SaveInterestsDto} from '../dtos/request/discovery.dto';
import {DiscoveryApiService} from '../services/discovery-api.service';
import {ProfileService} from '../services/profile.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';
import {withOptimisticEntities} from './foundation/with-optimistic-entities';

/**
 * A stable key for one filter combination, so `q=`, `topics=` and `language=` each get their own
 * cached page rather than sharing a slot with whatever was browsed last.
 */
export function discoveryFeedKey(query: DiscoveryFeedQuery): string {
    const topics = [...(query.topics ?? [])].sort();
    return JSON.stringify([query.q?.trim() ?? '', topics, query.language ?? '']);
}

interface DiscoveryInterestsState {
    interests: InterestsDto | null;
    interestsLoading: boolean;
}

/**
 * The Discover feed, one guild's own listing, and the caller's interests.
 *
 * Two entity shapes, on purpose: a feed card ({@link DiscoveryCardDto}) is what strangers see, a
 * listing ({@link ListingDto}) is what the guild edits, and they never share a row - see the doc on
 * {@link DiscoveryCardDto}.
 */
export const DiscoveryStore = signalStore(
    {providedIn: 'root'},
    withEntities<DiscoveryCardDto>(),
    withEntities<ListingDto, 'listingRow'>({entity: type<ListingDto>(), collection: 'listingRow'}),

    withKeyedIndex<DiscoveryCardDto, 'feed', DiscoveryFeedQuery, DiscoveryFeedDto>({
        collection: 'feed',
        selectId: card => card.listingId,
        rows: response => response.cards,
        fetch: () => {
            const api = inject(DiscoveryApiService);
            return (_key: string, arg?: DiscoveryFeedQuery) => api.discover(arg ?? {});
        },
        paging: {
            cursorOf: response => response.nextCursor,
            fetch: () => {
                const api = inject(DiscoveryApiService);
                return (_key: string, cursor: string, arg?: DiscoveryFeedQuery) =>
                    api.discover({...(arg ?? {}), cursor});
            },
        },
    }),

    withKeyedIndex<ListingDto, 'listing', 'listingRow', never, ListingDto | null>({
        collection: 'listing',
        entities: 'listingRow',
        rows: response => (response ? [response] : []),
        fetch: () => {
            const api = inject(DiscoveryApiService);
            return (guildId: string) =>
                api.getListing(guildId).pipe(
                    // A guild that never drafted a listing answers 404, which is "nothing yet",
                    // not a load failure.
                    catchError(err =>
                        err instanceof HttpErrorResponse && err.status === 404
                            ? of(null)
                            : throwError(() => err),
                    ),
                );
        },
    }),

    withOptimisticEntities<DiscoveryCardDto>(card => card.listingId),

    withState<DiscoveryInterestsState>({interests: null, interestsLoading: false}),

    withMethods((store, api = inject(DiscoveryApiService), profile = inject(ProfileService)) => {
        const ownUserId = (): string => profile.ownProfile()?.userId ?? '';

        const rowOf = (guildId: string): ListingDto | null => store.listingFor(guildId)()[0] ?? null;

        /**
         * Patches a listing row in place and hands back its undo. Hand-rolled rather than
         * `withOptimisticEntities`, which only reaches the store's one unnamed collection and this
         * row lives in the named `listingRow` collection.
         */
        const patchListing = (id: string, changes: Partial<ListingDto>): (() => void) => {
            const before = store.listingRowEntityMap()[id];
            if (!before) return () => undefined;

            const restore: Partial<ListingDto> = {};
            for (const field of Object.keys(changes) as (keyof ListingDto)[]) {
                (restore as Record<string, unknown>)[field] = before[field];
            }
            patchState(store, updateEntity({id, changes}, {collection: 'listingRow'}));
            return () => patchState(store, updateEntity({id, changes: restore}, {collection: 'listingRow'}));
        };

        /** A suspended or unlisted card must stop showing in Discover, wherever it is loaded. */
        const dropCard = (listingId: string): void => {
            if (!(listingId in store.entityMap())) return;
            store.bumpGeneration(listingId);
            patchState(store, removeEntity(listingId));
        };

        return {
            /**
             * Cold, like `ScheduledEventStore.toggleInterest`: the optimistic patch only happens on
             * subscribe, so building the call and never subscribing touches nothing. Draft-only
             * guilds have no row yet, so there is nothing to patch optimistically.
             */
            saveDraft(guildId: string, dto: ListingWriteDto): Observable<ListingDto> {
                return defer(() => {
                    const current = rowOf(guildId);
                    const rollback = current
                        ? patchListing(current.id, {
                              headline: dto.headline,
                              pitch: dto.pitch,
                              language: dto.language,
                              joinPolicy: dto.joinPolicy,
                              links: dto.links,
                          })
                        : () => undefined;

                    return api.saveListing(guildId, dto).pipe(
                        tap(listing => store.attachToListing(guildId, listing)),
                        catchError(err => {
                            rollback();
                            return throwError(() => err);
                        }),
                    );
                });
            },

            /**
             * Flips `state` to `Published` on screen the instant it is asked for. A refused publish
             * (the guild's plan does not include Discovery) rolls only that field back - the
             * headline and pitch a person might still be mid-edit on are never touched here.
             */
            publish(guildId: string): Observable<ListingDto> {
                return defer(() => {
                    const current = rowOf(guildId);
                    const rollback = current
                        ? patchListing(current.id, {state: 'Published'})
                        : () => undefined;

                    return api.publish(guildId).pipe(
                        tap(listing => store.attachToListing(guildId, listing)),
                        catchError(err => {
                            rollback();
                            return throwError(() => err);
                        }),
                    );
                });
            },

            unlist(guildId: string): Observable<ListingDto> {
                return defer(() => {
                    const current = rowOf(guildId);
                    const rollback = current
                        ? patchListing(current.id, {state: 'Unlisted'})
                        : () => undefined;

                    return api.unlist(guildId).pipe(
                        tap(listing => store.attachToListing(guildId, listing)),
                        catchError(err => {
                            rollback();
                            return throwError(() => err);
                        }),
                    );
                });
            },

            /** No optimistic guess: `bumpAvailableAt` is server-computed, and a wrong guess is worse than a wait. */
            bump(guildId: string): Observable<ListingDto> {
                return api.bump(guildId).pipe(tap(listing => store.attachToListing(guildId, listing)));
            },

            loadInterests(): void {
                if (store.interestsLoading()) return;
                patchState(store, {interestsLoading: true});
                api.getInterests().subscribe({
                    next: interests => patchState(store, {interests, interestsLoading: false}),
                    error: () => patchState(store, {interestsLoading: false}),
                });
            },

            saveInterests(dto: SaveInterestsDto): Observable<InterestsDto> {
                return api.saveInterests(dto).pipe(tap(interests => patchState(store, {interests})));
            },

            // ── Realtime ─────────────────────────────────────────────────────
            //
            // Every handler bails on a guild whose listing nobody has opened. Accumulating events
            // for a listing never fetched would materialize a phantom row nothing asked for.

            // Partial payload (id, guild, state only): refetch rather than patch a guess in place.
            applyListingChanged(event: WsListingChanged): void {
                if (store.listingHeld(event.guildId)) {
                    store.invalidateListing(event.guildId);
                    store.loadListing(event.guildId);
                }
                if (event.state === 'Unlisted' || event.state === 'Suspended') dropCard(event.listingId);
            },

            applyListingSuspended(event: WsListingSuspended): void {
                if (store.listingHeld(event.guildId)) {
                    store.invalidateListing(event.guildId);
                    store.loadListing(event.guildId);
                }
                dropCard(event.listingId);
            },

            /**
             * Only the caller's own interests change the feed's `matchedTopics`, and the server has
             * no notion of a client-side feed key - so every held key is requeued rather than one
             * addressed by the event.
             */
            applyInterestsChanged(event: WsInterestsChanged): void {
                if (event.userId !== ownUserId()) return;
                for (const key of Object.keys(store.feedRequests())) {
                    if (!store.feedHeld(key)) continue;
                    store.invalidateFeed(key);
                    store.loadFeed(key);
                }
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('discovery.ListingPublished').subscribe(e => store.applyListingChanged(e));
            realtime.stream('discovery.ListingUpdated').subscribe(e => store.applyListingChanged(e));
            realtime.stream('discovery.ListingUnlisted').subscribe(e => store.applyListingChanged(e));
            realtime.stream('discovery.ListingSuspended').subscribe(e => store.applyListingSuspended(e));
            realtime.stream('discovery.InterestsChanged').subscribe(e => store.applyInterestsChanged(e));
        },
    }),
);
