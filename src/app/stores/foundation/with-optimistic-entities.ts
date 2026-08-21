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
import {EntityId, EntityMap, EntityState, updateEntity, upsertEntity} from '@ngrx/signals/entities';

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
 * The stale-response guard for entity writes. Tick, untick, tick again is three requests that can
 * land in any order, and without a generation per entity the stale one wins whenever it finishes last.
 */
export function withOptimisticEntities<T>(
    selectId: (entity: T) => EntityId = entity => (entity as {id: EntityId}).id,
): SignalStoreFeature<
    EmptyFeatureResult & {state: EntityState<T>},
    {
        state: EmptyFeatureResult['state'];
        props: OptimisticEntities<T>;
        methods: EmptyFeatureResult['methods'];
    }
> {
    const feature = signalStoreFeature(
        {state: type<EntityState<T>>()},
        withProps(store => {
            const source = store as unknown as WritableStateSource<EntityState<T>>;
            const entityMap = (store as unknown as {entityMap: Signal<EntityMap<T>>}).entityMap;
            const generations = new Map<EntityId, number>();

            const bumpGeneration = (id: EntityId): number => {
                const next = (generations.get(id) ?? 0) + 1;
                generations.set(id, next);
                return next;
            };

            const isCurrentGeneration = (id: EntityId, generation: number): boolean =>
                (generations.get(id) ?? 0) === generation;

            const write = (id: EntityId, changes: Partial<T>): void => {
                patchState(source as never, updateEntity<T>({id, changes}, {selectId}) as never);
            };

            return {
                bumpGeneration,
                isCurrentGeneration,

                optimistic(id: EntityId, changes: Partial<T>): OptimisticWrite<T> {
                    const before = entityMap()[id];
                    const generation = bumpGeneration(id);
                    if (!before) {
                        return {rollback: () => undefined, settle: () => undefined};
                    }

                    const restore: Partial<T> = {};
                    for (const field of Object.keys(changes) as (keyof T)[]) restore[field] = before[field];
                    write(id, changes);

                    return {
                        rollback: () => {
                            if (!isCurrentGeneration(id, generation)) return;
                            write(id, restore);
                        },
                        settle: (entity: T) => {
                            if (!isCurrentGeneration(id, generation)) return;
                            patchState(source as never, upsertEntity<T>(entity, {selectId}) as never);
                        },
                    };
                },
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
