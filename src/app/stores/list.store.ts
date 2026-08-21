import {computed, inject, Signal} from '@angular/core';
import {firstValueFrom, map} from 'rxjs';
import {patchState, signalStore, withHooks, withMethods} from '@ngrx/signals';
import {removeEntity, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {
    ListCleared,
    ListItem,
    ListItemChecked,
    ListItemCreated,
    ListItemDeleted,
    ListItemsReordered,
    ListItemUpdated,
    normalizeCreatedItem,
    renumberPositions,
    reorderByPartialIds,
} from '../dtos/response/list.dto';
import {CreateListItemDto, UpdateListItemDto} from '../dtos/request/list.dto';
import {ListApiService} from '../services/list-api.service';
import {ProfileService} from '../services/profile.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';
import {withOptimisticEntities} from './foundation/with-optimistic-entities';

/** Everything a rendered list needs; one of these per List channel the user has opened. */
export interface ListChannelState {
    /** In display order. Array order is authoritative, not `position`, see `renumberPositions`. */
    items: ListItem[];
    loading: boolean;
    /**
     * True once a fetch for this channel has succeeded at least once. `items: []` alone cannot tell
     * "not fetched yet" from "the list really is empty", and a view that mounted before its first
     * response would paint the empty state instead of a spinner.
     */
    hasLoaded: boolean;
    loadFailed: boolean;
    /**
     * The load came back `403`, which on its own does not mean "you lack permission": it is also
     * what a guild whose `Lists` module is off returns, for everyone including the owner. The caller
     * must read the guild's `features` first and render nothing at all in that case.
     */
    forbidden: boolean;
}

/** Handed out for channels nobody has opened. Shared and frozen: an answer, never a working copy. */
const EMPTY_STATE: ListChannelState = Object.freeze({
    items: Object.freeze([] as ListItem[]) as ListItem[],
    loading: false,
    hasLoaded: false,
    loadFailed: false,
    forbidden: false,
});

/** Prefix for the id an optimistic row carries until the server mints a real one. */
const TEMP_ID_PREFIX = 'tmp:';

export function isTempListItemId(id: string): boolean {
    return id.startsWith(TEMP_ID_PREFIX);
}

function sameState(a: ListChannelState, b: ListChannelState): boolean {
    return (
        a.items === b.items &&
        a.loading === b.loading &&
        a.hasLoaded === b.hasLoaded &&
        a.loadFailed === b.loadFailed &&
        a.forbidden === b.forbidden
    );
}

/**
 * The contents of every `List` channel the user has opened, plus every mutation against them.
 *
 * Two people in the same shop: one ticks milk and the strike-through has to reach the other phone
 * before the second trolley gets one too. So every mutation is applied locally the instant it is
 * asked for, the request goes out behind it, and the server's answer overwrites the guess.
 *
 * Nothing here is a toggle. Ticking is `setChecked(id, true)`, an absolute value, all the way down
 * to the realtime handler: the server's check route is idempotent and broadcasts nothing on a
 * repeat, so a handler that flipped a boolean would be correct until two events raced and
 * permanently wrong after.
 */
export const ListStore = signalStore(
    {providedIn: 'root'},
    withEntities<ListItem>(),

    withKeyedIndex<ListItem, 'items'>({
        collection: 'items',
        fetch: () => {
            const api = inject(ListApiService);
            // Sorted here and only here. From this point the id order is the order, so a realtime
            // reorder does not have to invent positions for rows it did not name.
            return (channelId: string) =>
                api
                    .items(channelId)
                    .pipe(
                        map(items => renumberPositions([...items].sort((a, b) => a.position - b.position))),
                    );
        },
    }),

    withOptimisticEntities<ListItem>(),

    withMethods((store, api = inject(ListApiService), profiles = inject(ProfileService)) => {
        const views = new Map<string, Signal<ListChannelState>>();
        let tempCounter = 0;

        const rowsOf = (channelId: string): ListItem[] => store.itemsFor(channelId)();
        const holds = (channelId: string, itemId: string): boolean =>
            rowsOf(channelId).some(row => row.id === itemId);

        const ownUserId = (): string => profiles.ownProfile()?.userId ?? '';

        /** Replaces the row with this id in place, or appends it. Order is never disturbed by an update. */
        const upsertRow = (items: readonly ListItem[], item: ListItem): ListItem[] => {
            const index = items.findIndex(row => row.id === item.id);
            if (index < 0) return [...items, {...item, position: items.length}];
            const next = [...items];
            next[index] = item;
            return next;
        };

        const draftItem = (channelId: string, dto: CreateListItemDto, position: number): ListItem => ({
            id: `${TEMP_ID_PREFIX}${++tempCounter}`,
            channelId,
            text: dto.text,
            quantity: dto.quantity ?? null,
            note: dto.note ?? null,
            section: dto.section ?? null,
            assigneeUserId: dto.assigneeUserId ?? null,
            addedByUserId: ownUserId(),
            isChecked: false,
            checkedAt: null,
            checkedByUserId: null,
            position,
            sourcePantryItemId: null,
            createdAt: new Date().toISOString(),
        });

        /**
         * The optimistic guess at what the PATCH will do, applied the way the server applies it.
         * `clearAssignee` is a wire flag rather than a field, so spreading the dto would leave
         * `assigneeUserId` untouched and put a `clearAssignee` key on the row.
         */
        const patchFields = (dto: UpdateListItemDto): Partial<ListItem> => {
            const {clearAssignee, ...fields} = dto;
            const changes: Partial<ListItem> = {...fields};
            if (clearAssignee) changes.assigneeUserId = null;
            return changes;
        };

        return {
            /**
             * Never null. A channel nobody has opened reads as the shared frozen default without
             * gaining an entry, so realtime events cannot start applying to a list never fetched.
             */
            stateFor(channelId: string): Signal<ListChannelState> {
                const cached = views.get(channelId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const items = store.itemsFor(channelId)();
                        if (!store.itemsTracked(channelId) && items.length === 0) return EMPTY_STATE;
                        const error = store.itemsError(channelId);
                        return {
                            items,
                            loading: store.itemsLoading(channelId),
                            hasLoaded: store.itemsLoaded(channelId),
                            loadFailed: error !== null,
                            forbidden: error === 'forbidden',
                        };
                    },
                    {equal: sameState},
                );

                views.set(channelId, view);
                return view;
            },

            /** Fetches once per channel per session; a list already loaded or in flight is left alone. */
            ensureLoaded(channelId: string): void {
                store.loadItems(channelId);
            },

            reload(channelId: string): void {
                store.loadItems(channelId, {force: true});
            },

            /** Adds a row on screen first. Returns false only after the row has been rolled back. */
            async addItem(channelId: string, dto: CreateListItemDto): Promise<void> {
                const optimistic = draftItem(channelId, dto, rowsOf(channelId).length);
                store.attachToItems(channelId, optimistic);

                try {
                    const created = await firstValueFrom(api.create(channelId, dto));
                    // Remove-then-upsert rather than replace-in-place: if the broadcast beat the
                    // response, the real row is already there and a blind replace would duplicate it.
                    const without = rowsOf(channelId).filter(row => row.id !== optimistic.id);
                    store.applyItems(channelId, upsertRow(without, created));
                } finally {
                    store.detachFromItems(channelId, optimistic.id);
                    patchState(store, removeEntity(optimistic.id));
                }
            },

            /** Ticks or unticks, an absolute value, never a flip. */
            async setChecked(channelId: string, itemId: string, checked: boolean): Promise<void> {
                if (!holds(channelId, itemId)) return;

                const now = new Date().toISOString();
                const write = store.optimistic(itemId, {
                    isChecked: checked,
                    // Cleared on untick rather than left behind, so "ticked by Ada" cannot outlive the tick.
                    checkedAt: checked ? now : null,
                    checkedByUserId: checked ? ownUserId() : null,
                });

                try {
                    write.settle(await firstValueFrom(checked ? api.check(itemId) : api.uncheck(itemId)));
                } catch (err) {
                    write.rollback();
                    throw err;
                }
            },

            async updateItem(channelId: string, itemId: string, dto: UpdateListItemDto): Promise<void> {
                if (!holds(channelId, itemId)) return;

                const write = store.optimistic(itemId, patchFields(dto));
                try {
                    write.settle(await firstValueFrom(api.update(itemId, dto)));
                } catch (err) {
                    write.rollback();
                    throw err;
                }
            },

            async deleteItem(channelId: string, itemId: string): Promise<void> {
                const items = rowsOf(channelId);
                const index = items.findIndex(row => row.id === itemId);
                if (index < 0) return;
                const before = items[index];

                store.bumpGeneration(itemId);
                store.detachFromItems(channelId, itemId);

                try {
                    await firstValueFrom(api.remove(itemId));
                    patchState(store, removeEntity(itemId));
                } catch (err) {
                    // Back at its old index, not appended: a failed delete must look like nothing
                    // happened, and re-appending would silently reorder the list instead.
                    const current = rowsOf(channelId);
                    if (!current.some(row => row.id === itemId)) {
                        const restored = [...current];
                        restored.splice(Math.min(index, restored.length), 0, before);
                        store.applyItems(channelId, restored);
                    }
                    throw err;
                }
            },

            /**
             * Moves one row and sends the smallest payload that describes the result. Omitted ids
             * land after the ones sent, so the sendable neighbourhood is a prefix: everything from
             * the top down to the further of the two indices. Sending only the two rows that
             * swapped would teleport them to the head of the list.
             */
            async moveItem(channelId: string, fromIndex: number, toIndex: number): Promise<boolean> {
                const before = rowsOf(channelId);
                if (fromIndex === toIndex) return true;
                if (fromIndex < 0 || fromIndex >= before.length) return false;

                const target = Math.max(0, Math.min(toIndex, before.length - 1));
                const next = [...before];
                const [moved] = next.splice(fromIndex, 1);
                next.splice(target, 0, moved);

                const prefix = next.slice(0, Math.max(fromIndex, target) + 1).map(row => row.id);
                store.applyItems(channelId, renumberPositions(next));

                try {
                    await firstValueFrom(api.reorder(channelId, {itemIds: prefix}));
                    return true;
                } catch (err) {
                    // Restored by id rather than wholesale, so a row created or ticked during the
                    // failed request is not thrown away with the failed order.
                    store.applyItems(
                        channelId,
                        renumberPositions(
                            reorderByPartialIds(
                                rowsOf(channelId),
                                before.map(row => row.id),
                            ),
                        ),
                    );
                    throw err;
                }
            },

            /** "Clear done" drops every ticked row. Needs `ManageLists`. */
            async clearChecked(channelId: string): Promise<boolean> {
                const before = rowsOf(channelId);
                const remaining = before.filter(row => !row.isChecked);
                if (remaining.length === before.length) return true;

                store.applyItems(channelId, renumberPositions(remaining));

                try {
                    await firstValueFrom(api.clearChecked(channelId));
                    return true;
                } catch (err) {
                    store.applyItems(channelId, before);
                    throw err;
                }
            },

            // ── Realtime ─────────────────────────────────────────────────────
            //
            // Every handler bails on a channel with no state. Accumulating events into a list that
            // was never fetched produces a channel showing only what happened since the socket
            // connected, which is worse than a spinner until it is opened.

            applyCreated({channelId, item}: ListItemCreated): void {
                if (!store.itemsTracked(channelId)) return;
                const existing = rowsOf(channelId).find(row => row.id === item.id) ?? null;
                const normalized = normalizeCreatedItem(item, existing);
                store.attachToItems(
                    channelId,
                    existing ? normalized : {...normalized, position: rowsOf(channelId).length},
                );
            },

            // Only for rows already held. An update for an unknown id is a row this client never
            // fetched, created while a load was in flight; the create event places it, not this one.
            applyUpdated({channelId, item}: ListItemUpdated): void {
                if (!store.itemsTracked(channelId) || !holds(channelId, item.id)) return;
                patchState(store, upsertEntity(item));
            },

            /**
             * The other phone in the shop. The event carries the whole row, so this assigns
             * `isChecked` from it rather than flipping anything: the server broadcasts nothing at
             * all when a tick was a no-op, so the events a client sees are not a complete sequence
             * of transitions and cannot be replayed as one.
             */
            applyChecked({channelId, item}: ListItemChecked): void {
                if (!store.itemsTracked(channelId)) return;
                // Our own echo bumps the generation too, so a response still in flight for this row
                // is now stale and will not be allowed to overwrite the newer broadcast.
                store.bumpGeneration(item.id);
                if (!holds(channelId, item.id)) return;
                patchState(store, upsertEntity(item));
            },

            applyDeleted({channelId, itemId}: ListItemDeleted): void {
                if (!store.itemsTracked(channelId)) return;
                store.bumpGeneration(itemId);
                store.detachFromItems(channelId, itemId);
            },

            // The broadcast echoes exactly what the reordering client sent, so it is partial in the
            // same way, and the same rule applies to it as to the request.
            applyReordered({channelId, itemIds}: ListItemsReordered): void {
                if (!store.itemsTracked(channelId)) return;
                store.applyItems(
                    channelId,
                    renumberPositions(reorderByPartialIds(rowsOf(channelId), itemIds)),
                );
            },

            // `removedCount` does not decide what goes: the checked set is the definition, and
            // trusting a count against a list this client may not have caught up on drops the wrong rows.
            applyCleared({channelId}: ListCleared): void {
                if (!store.itemsTracked(channelId)) return;
                store.applyItems(
                    channelId,
                    renumberPositions(rowsOf(channelId).filter(row => !row.isChecked)),
                );
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.ListItemCreated').subscribe(e => store.applyCreated(e));
            realtime.stream('guild.ListItemUpdated').subscribe(e => store.applyUpdated(e));
            realtime.stream('guild.ListItemChecked').subscribe(e => store.applyChecked(e));
            realtime.stream('guild.ListItemDeleted').subscribe(e => store.applyDeleted(e));
            realtime.stream('guild.ListItemsReordered').subscribe(e => store.applyReordered(e));
            realtime.stream('guild.ListCleared').subscribe(e => store.applyCleared(e));
        },
    }),
);
