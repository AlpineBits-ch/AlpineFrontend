import {computed, Signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable} from 'rxjs';
import {
    EmptyFeatureResult,
    getState,
    patchState,
    signalStoreFeature,
    SignalStoreFeature,
    type,
    withMethods,
    withState,
    WritableStateSource,
} from '@ngrx/signals';
import {
    EntityId,
    EntityMap,
    EntityState,
    NamedEntityState,
    SelectEntityId,
    upsertEntities,
} from '@ngrx/signals/entities';
import {KeyedRequest, LoadFailure} from './request-state';

/**
 * A key-to-ids index over the entity map `withEntities` already holds, plus that key's request
 * state. Compose it more than once to hold one entity under two differently keyed lists.
 *
 * `A` is a per-call fetch argument, for an index whose request the key alone does not describe.
 * `E` names a `withEntities` collection, for a store holding more than one row type.
 * `R` is the fetch's whole response and `S` the sibling state `onLoaded` writes alongside the rows.
 */
export interface KeyedIndexConfig<T, C extends string, A, E extends string, R, S extends object> {
    /** Names every generated member, so one store can carry two indexes over one entity map. */
    collection: C;
    /**
     * The `withEntities` collection this index reads. Omit for a store with one unnamed entity map.
     * That store must spell its type arguments: `withEntities<Row, 'row'>({entity: type<Row>(), collection: 'row'})`,
     * because the inferred form collapses this feature's input to `object` and the store stops typechecking.
     */
    entities?: E;
    /** Omit for an index only a realtime invalidation makes stale. A number literal here, never an imported const. */
    staleMs?: number;
    /** Applied when a key's list is read, so a row attached by a realtime event lands in the right place. */
    sort?: (a: T, b: T) => number;
    selectId?: SelectEntityId<T>;
    /** Resolved once, inside the injection context. The function it returns is called per load. */
    fetch: () => (key: string, arg?: A) => Observable<R>;
    /** Pulls the rows out of the response. Omit when the response is the rows. */
    rows?: (response: R) => T[];
    /**
     * Sibling state to write from the rest of the response. The patch lands in the same
     * `patchState` as the rows and the id list, so nothing can read totals that disagree with them.
     * Not called on a failure.
     */
    onLoaded?: (response: R, key: string, state: S) => Partial<S>;
}

export interface LoadOptions<A> {
    arg?: A;
    /** Refetches however fresh the key is. */
    force?: boolean;
}

type KeyedIndexState<C extends string> = Record<`${C}Ids`, Record<string, EntityId[]>> &
    Record<`${C}Requests`, Record<string, KeyedRequest>>;

// `${C}Tracked` is "a fetch was issued for this key", `${C}Loaded` is "one came back successfully",
// `${C}Held` is "this key has rows or a request record". A realtime drop rule wants `Held`; a
// "have I ever fetched this" guard wants `Tracked`, and swapping the two makes a key never load.
type KeyedIndexMethods<T, C extends string, A> = Record<`${C}For`, (key: string) => Signal<T[]>> &
    Record<`${C}Loading`, (key: string) => boolean> &
    Record<`${C}Error`, (key: string) => LoadFailure | null> &
    Record<`${C}Tracked`, (key: string) => boolean> &
    Record<`${C}Loaded`, (key: string) => boolean> &
    Record<`${C}Held`, (key: string) => boolean> &
    Record<`${C}LoadedAt`, (key: string) => number> &
    Record<`load${Capitalize<C>}`, (key: string, options?: LoadOptions<A>) => void> &
    Record<`invalidate${Capitalize<C>}`, (key: string) => void> &
    Record<`invalidateAll${Capitalize<C>}`, () => void> &
    Record<`apply${Capitalize<C>}`, (key: string, items: T[]) => void> &
    Record<`attachTo${Capitalize<C>}`, (key: string, entity: T) => void> &
    Record<`detachFrom${Capitalize<C>}`, (key: string, id: EntityId) => void>;

type KeyedIndexOutput<T, C extends string, A> = {
    state: KeyedIndexState<C>;
    props: EmptyFeatureResult['props'];
    methods: KeyedIndexMethods<T, C, A>;
};

// `${collection}For` caches one computed per key for the life of the store, bounded by the number
// of channels or guilds opened in a session. Indexing by message id would need eviction first.
export function withKeyedIndex<T, C extends string, A = never, R = T[], S extends object = object>(
    config: KeyedIndexConfig<T, C, A, never, R, S> & {entities?: undefined},
): SignalStoreFeature<EmptyFeatureResult & {state: EntityState<T> & S}, KeyedIndexOutput<T, C, A>>;
export function withKeyedIndex<
    T,
    C extends string,
    E extends string,
    A = never,
    R = T[],
    S extends object = object,
>(
    config: KeyedIndexConfig<T, C, A, E, R, S> & {entities: E},
): SignalStoreFeature<EmptyFeatureResult & {state: NamedEntityState<T, E> & S}, KeyedIndexOutput<T, C, A>>;
export function withKeyedIndex<T, C extends string, A, E extends string, R, S extends object>(
    config: KeyedIndexConfig<T, C, A, E, R, S>,
): SignalStoreFeature<EmptyFeatureResult & {state: EntityState<T>}, KeyedIndexOutput<T, C, A>> {
    const collection = config.collection;
    const idsKey = `${collection}Ids`;
    const requestsKey = `${collection}Requests`;
    const capitalized = collection.charAt(0).toUpperCase() + collection.slice(1);
    const entities = config.entities;
    const entityMapKey = entities === undefined ? 'entityMap' : `${entities}EntityMap`;

    const feature = signalStoreFeature(
        {state: type<EntityState<T>>()},
        withState({[idsKey]: {}, [requestsKey]: {}}),
        withMethods(store => {
            const source = store as unknown as WritableStateSource<Record<string, unknown>>;
            const entityMap = (store as unknown as Record<string, Signal<EntityMap<T>>>)[entityMapKey];
            const reader = store as unknown as Record<string, Signal<Record<string, never>>>;
            const idsSignal = reader[idsKey] as unknown as Signal<Record<string, EntityId[]>>;
            const requestsSignal = reader[requestsKey] as unknown as Signal<Record<string, KeyedRequest>>;

            const selectId = config.selectId ?? ((entity: T) => (entity as {id: EntityId}).id);
            const rowsOf = config.rows ?? ((response: R) => response as unknown as T[]);
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
                    generation: 0,
                };

            const patchRequest = (key: string, changes: Partial<KeyedRequest>): void => {
                patchState(source, {
                    [requestsKey]: {...requestsSignal(), [key]: {...requestOf(key), ...changes}},
                });
            };

            // Row-for-row identity, so a write to some other key's entity does not hand this key a
            // fresh array and churn every `@for` reading it.
            const sameRows = (a: T[], b: T[]): boolean =>
                a.length === b.length && a.every((row, index) => row === b[index]);

            const viewFor = (key: string): Signal<T[]> => {
                const cached = views.get(key);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const ids = idsSignal()[key];
                        if (!ids) return [] as T[];
                        const map = entityMap();
                        const rows = ids.map(id => map[id]).filter((row): row is T => row != null);
                        return config.sort ? [...rows].sort(config.sort) : rows;
                    },
                    {equal: sameRows},
                );

                views.set(key, view);
                return view;
            };

            const upsertRows = (rows: T[]) =>
                (entities === undefined
                    ? upsertEntities<T>(rows, {selectId})
                    : upsertEntities<T, string>(rows, {collection: entities, selectId})) as never;

            const writeIds = (key: string, ids: EntityId[], rows: T[]): void => {
                patchState(source as never, upsertRows(rows), {
                    [idsKey]: {...idsSignal(), [key]: ids},
                } as never);
            };

            const apply = (key: string, items: T[]): void => {
                writeIds(key, items.map(selectId), items);
            };

            /**
             * The load path's write. The rows, the id list, the request record and whatever
             * `onLoaded` returns all land in one patch, so nothing renders between them.
             */
            const applyLoaded = (key: string, response: R, request: Partial<KeyedRequest>): void => {
                const items = rowsOf(response);
                const updaters: unknown[] = [
                    upsertRows(items),
                    {[idsKey]: {...idsSignal(), [key]: items.map(selectId)}},
                    {[requestsKey]: {...requestsSignal(), [key]: {...requestOf(key), ...request}}},
                ];
                if (config.onLoaded) {
                    updaters.push(config.onLoaded(response, key, getState(source) as unknown as S));
                }
                patchState(source as never, ...(updaters as never[]));
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
                const generation = requestOf(key).generation + 1;
                patchRequest(key, {loading: true, error: null, generation});
                fetchOne(key, args.get(key)).subscribe({
                    next: response => {
                        // An invalidation or a newer fetch while this was out. The rows still land,
                        // but the key stays stale so the next load re-reads it rather than
                        // answering from a response that was already known to be behind.
                        const superseded = requestOf(key).generation !== generation;
                        applyLoaded(
                            key,
                            response,
                            superseded
                                ? {loading: false, error: null}
                                : {loading: false, loadedAt: Date.now(), error: null, stale: false},
                        );
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
                const current = requestsSignal()[key];
                if (!current) return;
                patchRequest(key, {loadedAt: 0, stale: true, generation: current.generation + 1});
            };

            const invalidateAll = (): void => {
                const all = requestsSignal();
                const next: Record<string, KeyedRequest> = {};
                for (const [key, request] of Object.entries(all)) {
                    next[key] = {
                        ...request,
                        loadedAt: 0,
                        stale: true,
                        generation: request.generation + 1,
                    };
                }
                patchState(source, {[requestsKey]: next});
            };

            return {
                [`${collection}For`]: viewFor,
                [`${collection}Loading`]: (key: string) => requestsSignal()[key]?.loading ?? false,
                [`${collection}Error`]: (key: string) => requestsSignal()[key]?.error ?? null,
                [`${collection}Tracked`]: (key: string) => key in requestsSignal(),
                [`${collection}Loaded`]: (key: string) => (requestsSignal()[key]?.loadedAt ?? 0) > 0,
                [`${collection}Held`]: (key: string) => key in requestsSignal() || key in idsSignal(),
                [`${collection}LoadedAt`]: (key: string) => requestsSignal()[key]?.loadedAt ?? 0,
                [`load${capitalized}`]: load,
                [`invalidate${capitalized}`]: invalidate,
                [`invalidateAll${capitalized}`]: invalidateAll,
                [`apply${capitalized}`]: apply,
                [`attachTo${capitalized}`]: attachTo,
                [`detachFrom${capitalized}`]: detachFrom,
            };
        }),
    );

    return feature as unknown as SignalStoreFeature<
        EmptyFeatureResult & {state: EntityState<T>},
        KeyedIndexOutput<T, C, A>
    >;
}
