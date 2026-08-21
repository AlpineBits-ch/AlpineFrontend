import {computed, Signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable} from 'rxjs';
import {
    EmptyFeatureResult,
    patchState,
    signalStoreFeature,
    SignalStoreFeature,
    type,
    withMethods,
    withState,
    WritableStateSource,
} from '@ngrx/signals';
import {EntityId, EntityMap, EntityState, SelectEntityId, upsertEntities} from '@ngrx/signals/entities';
import {KeyedRequest, LoadFailure} from './request-state';

/**
 * A key-to-ids index over the entity map `withEntities` already holds, plus that key's request
 * state. Compose it more than once to hold one entity under two differently keyed lists.
 *
 * `A` is a per-call fetch argument, for an index whose request the key alone does not describe.
 */
export interface KeyedIndexConfig<T, C extends string, A> {
    /** Names every generated member, so one store can carry two indexes over one entity map. */
    collection: C;
    /** Omit for an index only a realtime invalidation makes stale. A number literal here, never an imported const. */
    staleMs?: number;
    /** Applied when a key's list is read, so a row attached by a realtime event lands in the right place. */
    sort?: (a: T, b: T) => number;
    selectId?: SelectEntityId<T>;
    /** Resolved once, inside the injection context. The function it returns is called per load. */
    fetch: () => (key: string, arg?: A) => Observable<T[]>;
}

export interface LoadOptions<A> {
    arg?: A;
    /** Refetches however fresh the key is. */
    force?: boolean;
}

type KeyedIndexInput<T> = EmptyFeatureResult & {state: EntityState<T>};

type KeyedIndexState<C extends string> = Record<`${C}Ids`, Record<string, EntityId[]>> &
    Record<`${C}Requests`, Record<string, KeyedRequest>>;

// `${C}Tracked` is "a fetch was issued for this key", `${C}Loaded` is "one came back successfully".
// The realtime drop rule wants one or the other, never both.
type KeyedIndexMethods<T, C extends string, A> = Record<`${C}For`, (key: string) => Signal<T[]>> &
    Record<`${C}Loading`, (key: string) => boolean> &
    Record<`${C}Error`, (key: string) => LoadFailure | null> &
    Record<`${C}Tracked`, (key: string) => boolean> &
    Record<`${C}Loaded`, (key: string) => boolean> &
    Record<`load${Capitalize<C>}`, (key: string, options?: LoadOptions<A>) => void> &
    Record<`invalidate${Capitalize<C>}`, (key: string) => void> &
    Record<`apply${Capitalize<C>}`, (key: string, items: T[]) => void> &
    Record<`attachTo${Capitalize<C>}`, (key: string, entity: T) => void> &
    Record<`detachFrom${Capitalize<C>}`, (key: string, id: EntityId) => void>;

// `${collection}For` caches one computed per key for the life of the store, bounded by the number
// of channels or guilds opened in a session. Indexing by message id would need eviction first.
export function withKeyedIndex<T, C extends string, A = never>(
    config: KeyedIndexConfig<T, C, A>,
): SignalStoreFeature<
    KeyedIndexInput<T>,
    {
        state: KeyedIndexState<C>;
        props: EmptyFeatureResult['props'];
        methods: KeyedIndexMethods<T, C, A>;
    }
> {
    const collection = config.collection;
    const idsKey = `${collection}Ids`;
    const requestsKey = `${collection}Requests`;
    const capitalized = collection.charAt(0).toUpperCase() + collection.slice(1);

    const feature = signalStoreFeature(
        {state: type<EntityState<T>>()},
        withState({[idsKey]: {}, [requestsKey]: {}}),
        withMethods(store => {
            const source = store as unknown as WritableStateSource<Record<string, unknown>>;
            const entityMap = (store as unknown as {entityMap: Signal<EntityMap<T>>}).entityMap;
            const reader = store as unknown as Record<string, Signal<Record<string, never>>>;
            const idsSignal = reader[idsKey] as unknown as Signal<Record<string, EntityId[]>>;
            const requestsSignal = reader[requestsKey] as unknown as Signal<Record<string, KeyedRequest>>;

            const selectId = config.selectId ?? ((entity: T) => (entity as {id: EntityId}).id);
            const fetchOne = config.fetch();
            const views = new Map<string, Signal<T[]>>();
            // The argument the last load for a key was issued under, replayed by a queued refetch.
            const args = new Map<string, A | undefined>();

            const requestOf = (key: string): KeyedRequest =>
                requestsSignal()[key] ?? {
                    loading: false,
                    loadedAt: 0,
                    error: null,
                    stale: false,
                    pendingRefetch: false,
                };

            const patchRequest = (key: string, changes: Partial<KeyedRequest>): void => {
                patchState(source, {
                    [requestsKey]: {...requestsSignal(), [key]: {...requestOf(key), ...changes}},
                });
            };

            const viewFor = (key: string): Signal<T[]> => {
                const cached = views.get(key);
                if (cached) return cached;

                const view = computed(() => {
                    const ids = idsSignal()[key];
                    if (!ids) return [] as T[];
                    const map = entityMap();
                    const rows = ids.map(id => map[id]).filter((row): row is T => row != null);
                    return config.sort ? [...rows].sort(config.sort) : rows;
                });

                views.set(key, view);
                return view;
            };

            const writeIds = (key: string, ids: EntityId[], entities: T[]): void => {
                patchState(
                    source as never,
                    upsertEntities<T>(entities, {selectId}) as never,
                    {[idsKey]: {...idsSignal(), [key]: ids}} as never,
                );
            };

            const apply = (key: string, items: T[]): void => {
                writeIds(key, items.map(selectId), items);
            };

            const attachTo = (key: string, entity: T): void => {
                const id = selectId(entity);
                const ids = idsSignal()[key] ?? [];
                writeIds(key, ids.includes(id) ? ids : [...ids, id], [entity]);
            };

            const detachFrom = (key: string, id: EntityId): void => {
                const ids = idsSignal()[key];
                if (!ids) return;
                patchState(source, {
                    [idsKey]: {...idsSignal(), [key]: ids.filter(held => held !== id)},
                });
            };

            const run = (key: string): void => {
                patchRequest(key, {loading: true, error: null});
                fetchOne(key, args.get(key)).subscribe({
                    next: items => {
                        apply(key, items);
                        patchRequest(key, {loading: false, loadedAt: Date.now(), error: null, stale: false});
                        drain(key);
                    },
                    error: (err: unknown) => {
                        // The key gets no id list at all, so "empty" and "refused" stay
                        // distinguishable, and `loadedAt: 0` keeps a retry possible.
                        patchRequest(key, {
                            loading: false,
                            loadedAt: 0,
                            stale: true,
                            error:
                                err instanceof HttpErrorResponse && err.status === 403
                                    ? 'forbidden'
                                    : 'failed',
                        });
                        drain(key);
                    },
                });
            };

            function drain(key: string): void {
                if (!requestOf(key).pendingRefetch) return;
                patchRequest(key, {pendingRefetch: false});
                run(key);
            }

            const load = (key: string, options?: LoadOptions<A>): void => {
                if (options && 'arg' in options) args.set(key, options.arg);
                const current = requestsSignal()[key];

                if (current?.loading) {
                    // Back-to-back opens wait for the request already out. Queue only when this
                    // one is known to be superseded: dropping that loses what invalidated it.
                    if (options?.force || current.stale) patchRequest(key, {pendingRefetch: true});
                    return;
                }

                const fresh =
                    current !== undefined &&
                    current.loadedAt > 0 &&
                    (config.staleMs === undefined || Date.now() - current.loadedAt <= config.staleMs);
                if (fresh && !options?.force) return;

                run(key);
            };

            const invalidate = (key: string): void => {
                if (!(key in requestsSignal())) return;
                patchRequest(key, {loadedAt: 0, stale: true});
            };

            return {
                [`${collection}For`]: viewFor,
                [`${collection}Loading`]: (key: string) => requestsSignal()[key]?.loading ?? false,
                [`${collection}Error`]: (key: string) => requestsSignal()[key]?.error ?? null,
                [`${collection}Tracked`]: (key: string) => key in requestsSignal(),
                [`${collection}Loaded`]: (key: string) => (requestsSignal()[key]?.loadedAt ?? 0) > 0,
                [`load${capitalized}`]: load,
                [`invalidate${capitalized}`]: invalidate,
                [`apply${capitalized}`]: apply,
                [`attachTo${capitalized}`]: attachTo,
                [`detachFrom${capitalized}`]: detachFrom,
            };
        }),
    );

    return feature as unknown as SignalStoreFeature<
        KeyedIndexInput<T>,
        {
            state: KeyedIndexState<C>;
            props: EmptyFeatureResult['props'];
            methods: KeyedIndexMethods<T, C, A>;
        }
    >;
}
