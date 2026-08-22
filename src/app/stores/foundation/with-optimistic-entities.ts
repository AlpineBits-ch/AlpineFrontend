import {Signal} from '@angular/core';
import {
    EmptyFeatureResult,
    patchState,
    signalStoreFeature,
    SignalStoreFeature,
    type,
    withProps,
    WritableStateSource,
} from '@ngrx/signals';
import {
    EntityId,
    EntityMap,
    EntityState,
    NamedEntityState,
    updateEntity,
    upsertEntity,
} from '@ngrx/signals/entities';

/** One in-flight optimistic write. Both halves are inert once a newer write for the same entity has been issued. */
export interface OptimisticWrite<T> {
    /** Puts the fields this write changed back the way it found them. */
    rollback(): void;
    /** Replaces the row with the server's answer. */
    settle(entity: T): void;
}

export interface OptimisticEntities<T> {
    /** Applies `changes` now and hands back the undo and the settle for the response. */
    optimistic(id: EntityId, changes: Partial<T>): OptimisticWrite<T>;
    /** Marks every response already in flight for this entity as stale, and returns the new generation. */
    bumpGeneration(id: EntityId): number;
    isCurrentGeneration(id: EntityId, generation: number): boolean;
}

/**
 * Same three members, named per collection - `optimisticFoo`, `bumpGenerationFoo`,
 * `isCurrentGenerationFoo` - because a second call composed for a second named collection would
 * otherwise overwrite the first one's `optimistic`/`bumpGeneration`/`isCurrentGeneration` outright.
 */
type NamedOptimisticEntities<T, C extends string> = Record<
    `optimistic${Capitalize<C>}`,
    (id: EntityId, changes: Partial<T>) => OptimisticWrite<T>
> &
    Record<`bumpGeneration${Capitalize<C>}`, (id: EntityId) => number> &
    Record<`isCurrentGeneration${Capitalize<C>}`, (id: EntityId, generation: number) => boolean>;

/**
 * The stale-response guard for entity writes. Tick, untick, tick again is three requests that can
 * land in any order, and without a generation per entity the stale one wins whenever it finishes last.
 *
 * Reaches the store's one unnamed entity collection by default. Pass a collection name first to
 * target a named one instead - same convention as `withKeyedIndex`, including the per-collection
 * member names: composing this twice under the default names would silently overwrite the first.
 */
export function withOptimisticEntities<T>(
    selectId?: (entity: T) => EntityId,
): SignalStoreFeature<
    EmptyFeatureResult & {state: EntityState<T>},
    {state: EmptyFeatureResult['state']; props: OptimisticEntities<T>; methods: EmptyFeatureResult['methods']}
>;
export function withOptimisticEntities<T, C extends string>(
    collection: C,
    selectId?: (entity: T) => EntityId,
): SignalStoreFeature<
    EmptyFeatureResult & {state: NamedEntityState<T, C>},
    {
        state: EmptyFeatureResult['state'];
        props: NamedOptimisticEntities<T, C>;
        methods: EmptyFeatureResult['methods'];
    }
>;
export function withOptimisticEntities<T, C extends string = string>(
    collectionOrSelectId?: C | ((entity: T) => EntityId),
    maybeSelectId?: (entity: T) => EntityId,
): SignalStoreFeature<
    EmptyFeatureResult & {state: EntityState<T>},
    {state: EmptyFeatureResult['state']; props: object; methods: EmptyFeatureResult['methods']}
> {
    const collection = typeof collectionOrSelectId === 'string' ? collectionOrSelectId : undefined;
    const selectId =
        (typeof collectionOrSelectId === 'function' ? collectionOrSelectId : maybeSelectId) ??
        ((entity: T) => (entity as {id: EntityId}).id);
    const entityMapKey = collection === undefined ? 'entityMap' : `${collection}EntityMap`;

    const feature = signalStoreFeature(
        {state: type<EntityState<T>>()},
        withProps(store => {
            const source = store as unknown as WritableStateSource<Record<string, unknown>>;
            const entityMap = (store as unknown as Record<string, Signal<EntityMap<T>>>)[entityMapKey];
            const generations = new Map<EntityId, number>();

            const bumpGeneration = (id: EntityId): number => {
                const next = (generations.get(id) ?? 0) + 1;
                generations.set(id, next);
                return next;
            };

            const isCurrentGeneration = (id: EntityId, generation: number): boolean =>
                (generations.get(id) ?? 0) === generation;

            const write = (id: EntityId, changes: Partial<T>): void => {
                const updater =
                    collection === undefined
                        ? updateEntity<T>({id, changes}, {selectId})
                        : updateEntity(
                              {id, changes: changes as never},
                              {collection, selectId: selectId as never},
                          );
                patchState(source as never, updater as never);
            };

            const settleEntity = (entity: T): void => {
                const updater =
                    collection === undefined
                        ? upsertEntity<T>(entity, {selectId})
                        : upsertEntity<T, string>(entity, {collection, selectId});
                patchState(source as never, updater as never);
            };

            const optimistic = (id: EntityId, changes: Partial<T>): OptimisticWrite<T> => {
                const before = entityMap()[id];
                const generation = bumpGeneration(id);
                if (!before) {
                    return {rollback: () => undefined, settle: () => undefined};
                }

                const restore: Partial<T> = {};
                for (const field of Object.keys(changes) as (keyof T)[]) {
                    (restore as Record<string, unknown>)[field as string] = (
                        before as Record<string, unknown>
                    )[field as string];
                }
                write(id, changes);

                return {
                    rollback: () => {
                        if (!isCurrentGeneration(id, generation)) return;
                        write(id, restore);
                    },
                    settle: (entity: T) => {
                        if (!isCurrentGeneration(id, generation)) return;
                        settleEntity(entity);
                    },
                };
            };

            if (collection === undefined) {
                return {optimistic, bumpGeneration, isCurrentGeneration};
            }
            const capitalized = collection.charAt(0).toUpperCase() + collection.slice(1);
            return {
                [`optimistic${capitalized}`]: optimistic,
                [`bumpGeneration${capitalized}`]: bumpGeneration,
                [`isCurrentGeneration${capitalized}`]: isCurrentGeneration,
            };
        }),
    );

    return feature as unknown as SignalStoreFeature<
        EmptyFeatureResult & {state: EntityState<T>},
        {
            state: EmptyFeatureResult['state'];
            props: OptimisticEntities<T>;
            methods: EmptyFeatureResult['methods'];
        }
    >;
}
