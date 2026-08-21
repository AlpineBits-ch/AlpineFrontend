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

export interface OptimisticEntities<T> {
    /**
     * Applies `changes` now and hands back the undo. The undo is inert once a newer mutation for
     * the same entity has been issued, so a late rollback cannot resurrect a value the user has
     * already moved past.
     */
    optimistic(id: EntityId, changes: Partial<T>): () => void;
    /** Marks every response already in flight for this entity as stale, and returns the new generation. */
    bumpGeneration(id: EntityId): number;
    isCurrentGeneration(id: EntityId, generation: number): boolean;
    /** Writes a settled server row, unless a newer local mutation was issued after `generation`. */
    settleEntity(id: EntityId, generation: number, entity: T): void;
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

                optimistic(id: EntityId, changes: Partial<T>): () => void {
                    const before = entityMap()[id];
                    if (!before) return () => undefined;

                    const generation = bumpGeneration(id);
                    const restore: Partial<T> = {};
                    for (const field of Object.keys(changes) as (keyof T)[]) restore[field] = before[field];

                    write(id, changes);

                    return () => {
                        if (!isCurrentGeneration(id, generation)) return;
                        write(id, restore);
                    };
                },

                settleEntity(id: EntityId, generation: number, entity: T): void {
                    if (!isCurrentGeneration(id, generation)) return;
                    patchState(source as never, upsertEntity<T>(entity, {selectId}) as never);
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
