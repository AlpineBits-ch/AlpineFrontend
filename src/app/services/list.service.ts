import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {TranslateService} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {
    ListCleared,
    ListItem,
    ListItemChecked,
    ListItemCreated,
    ListItemDeleted,
    ListItemsReordered,
    ListItemUpdated,
    LIST_LIMITS,
    normalizeCreatedItem,
    renumberPositions,
    reorderByPartialIds,
    validateNewListItem,
} from '../dtos/response/list.dto';
import {CreateListItemDto, UpdateListItemDto} from '../dtos/request/list.dto';
import {ListApiService} from './list-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {ProfileService} from './profile.service';
import {ToastService} from './toast.service';

/** Everything a rendered list needs; one of these per List channel the user has opened. */
export interface ListChannelState {
    /** In display order. Array order is authoritative, not `position` - see `renumberPositions`. */
    items: ListItem[];
    loading: boolean;
    /**
     * True once a fetch for this channel has succeeded at least once. `items: []` alone cannot
     * tell "not fetched yet" from "the list really is empty", and a view that mounted before its
     * first response would paint the empty state instead of a spinner.
     */
    hasLoaded: boolean;
    loadFailed: boolean;
    /**
     * The load came back `403`.
     *
     * <p>Which on its own does **not** mean "you lack permission" - it is also what a guild whose
     * `Lists` module is off returns, for everyone including the owner. The caller must read the
     * guild's `features` first and render nothing at all in that case; this flag only distinguishes
     * a refusal from a network failure once the module is known to be on.</p>
     */
    forbidden: boolean;
}

/**
 * Handed out for channels nobody has opened. Shared and frozen: a read-only answer to "what would
 * this list look like", never a working copy.
 */
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

/**
 * The contents of every `List` channel the user has opened, plus every mutation against them.
 *
 * <p>The defining use case is two people standing in the same shop: one of them ticks *milk* and
 * the strike-through has to reach the other phone before the second trolley gets one too. So every
 * mutation is applied locally the instant it is asked for, the request goes out behind it, and the
 * server's answer - by response or by broadcast - overwrites the guess. A failure rolls the guess
 * back rather than leaving the two phones disagreeing.</p>
 *
 * <p>Three rules run through all of it:</p>
 * <ul>
 *   <li><b>Nothing here is a toggle.</b> Ticking is `setChecked(id, true)`, an absolute value, all
 *   the way down to the realtime handler. The server's check route is idempotent and broadcasts
 *   nothing on a repeat, so a handler that flipped a boolean would be correct exactly until two
 *   events raced - and then permanently wrong.</li>
 *   <li><b>Array order is the order.</b> `position` is re-derived from the index after any move,
 *   because a partial reorder leaves the server's numbers describing an order that no longer
 *   exists locally.</li>
 *   <li><b>A channel nobody fetched gets no state.</b> Realtime events for it are dropped rather
 *   than accumulated into a list that was never loaded and would therefore be missing everything
 *   that happened before the socket connected.</li>
 * </ul>
 */
@Injectable({providedIn: 'root'})
export class ListService {
    private readonly stateByChannel = signal<Record<string, ListChannelState>>({});

    private api = inject(ListApiService);
    private realtime = inject(RealtimeConnectionService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    /**
     * Bumped per item on every local mutation. A response only applies if the generation it was
     * issued under is still current: tick, untick, tick again is three requests that can land in
     * any order, and without this the stale one wins whenever it happens to finish last.
     */
    private readonly itemGeneration = new Map<string, number>();

    /** Bumped per channel on every reload, so a superseded list response cannot overwrite a newer one. */
    private readonly loadGeneration = new Map<string, number>();

    private tempCounter = 0;

    constructor() {
        // Registered once, here, because `on()` does not deduplicate - a second registration
        // delivers every event twice, which for a tick means it strikes through and immediately
        // un-strikes. Safe before `start()`: handlers are queued and replayed onto the connection.
        this.realtime.on('guild.ListItemCreated', (d: ListItemCreated) => this.onCreated(d));
        this.realtime.on('guild.ListItemUpdated', (d: ListItemUpdated) => this.onUpdated(d));
        this.realtime.on('guild.ListItemChecked', (d: ListItemChecked) => this.onChecked(d));
        this.realtime.on('guild.ListItemDeleted', (d: ListItemDeleted) => this.onDeleted(d));
        this.realtime.on('guild.ListItemsReordered', (d: ListItemsReordered) => this.onReordered(d));
        this.realtime.on('guild.ListCleared', (d: ListCleared) => this.onCleared(d));
    }

    // ── Reading ─────────────────────────────────────────────────────────────

    /**
     * Never null. A channel nobody has opened reads as the empty default *without gaining an
     * entry* - creating one on read would make "has this channel been opened?" untrue, and
     * realtime events would start applying to a list that was never fetched.
     */
    stateFor(channelId: string): ListChannelState {
        return this.stateByChannel()[channelId] ?? EMPTY_STATE;
    }

    /** Fetches once per channel per session; a list already loaded or in flight is left alone. */
    ensureLoaded(channelId: string): void {
        const state = this.stateByChannel()[channelId];
        if (state?.hasLoaded || state?.loading) return;
        this.reload(channelId);
    }

    reload(channelId: string): void {
        const generation = (this.loadGeneration.get(channelId) ?? 0) + 1;
        this.loadGeneration.set(channelId, generation);
        this.patch(channelId, {loading: true, loadFailed: false, forbidden: false});

        this.api.items(channelId).subscribe({
            next: items => {
                if (this.loadGeneration.get(channelId) !== generation) return;
                // Sorted here and only here. From this point the array *is* the order, so a
                // realtime reorder does not have to invent positions for rows it did not name.
                const sorted = [...items].sort((a, b) => a.position - b.position);
                this.patch(channelId, {
                    items: renumberPositions(sorted),
                    loading: false,
                    hasLoaded: true,
                    loadFailed: false,
                    forbidden: false,
                });
            },
            error: (err: unknown) => {
                if (this.loadGeneration.get(channelId) !== generation) return;
                const forbidden = err instanceof HttpErrorResponse && err.status === 403;
                // `hasLoaded` deliberately untouched: a failed fetch must never read as loaded, or
                // a retry would be blocked forever and the view would paint "nothing on the list".
                this.patch(channelId, {loading: false, loadFailed: true, forbidden});
            },
        });
    }

    // ── Mutations ───────────────────────────────────────────────────────────

    /**
     * Adds a row, on screen first.
     *
     * <p>Both caps are checked before the request: the server answers a long `text` or a full list
     * with a bare `400` and no field information, which surfaces to the user as "Bad Request" for
     * having typed a long line.</p>
     *
     * @returns whether the row is on the server. `false` means it was refused or rolled back, and a
     *          toast has already explained which.
     */
    async addItem(channelId: string, dto: CreateListItemDto): Promise<boolean> {
        const state = this.stateFor(channelId);
        const rejection = validateNewListItem(dto.text, state.items.length);
        if (rejection) {
            if (rejection === 'TEXT_TOO_LONG') {
                this.toastService.error(this.translate.instant('LIST.ERROR_TEXT_TOO_LONG',
                    {max: LIST_LIMITS.textMaxLength}));
            } else if (rejection === 'LIST_FULL') {
                this.toastService.error(this.translate.instant('LIST.ERROR_LIST_FULL',
                    {max: LIST_LIMITS.maxItems}));
            }
            return false;
        }

        const optimistic = this.draftItem(channelId, dto, state.items.length);
        this.patch(channelId, {items: [...state.items, optimistic]});

        try {
            const created = await firstValueFrom(this.api.create(channelId, dto));
            // Remove-then-upsert rather than replace-in-place: if the broadcast beat the response,
            // the real row is already in the list and a blind replace would duplicate it.
            this.mutate(channelId, items =>
                this.upsert(items.filter(item => item.id !== optimistic.id), created));
            return true;
        } catch (err) {
            this.mutate(channelId, items => items.filter(item => item.id !== optimistic.id));
            this.toastService.httpError(this.translate.instant('LIST.ERROR_ADD'), err);
            return false;
        }
    }

    /**
     * Ticks or unticks - an absolute value, never a flip.
     *
     * <p>Already in the requested state means the request is skipped entirely. The server would
     * accept it (the route is idempotent, returning `200` with the row unchanged and broadcasting
     * nothing), so this is a saved round trip on a double-tap rather than a correctness fix - but
     * it is also the reason a repeat can never surface as an error: there is no failure path for
     * an operation that was not performed.</p>
     */
    async setChecked(channelId: string, itemId: string, checked: boolean): Promise<boolean> {
        const before = this.stateFor(channelId).items.find(item => item.id === itemId);
        if (!before) return false;
        if (before.isChecked === checked) return true;

        const generation = this.bumpGeneration(itemId);
        const now = new Date().toISOString();
        this.mutate(channelId, items => items.map(item => item.id === itemId ? {
            ...item,
            isChecked: checked,
            // Cleared on untick rather than left behind, so "ticked by Ada" cannot outlive the tick.
            checkedAt: checked ? now : null,
            checkedByUserId: checked ? this.ownUserId() : null,
        } : item));

        try {
            const updated = await firstValueFrom(
                checked ? this.api.check(itemId) : this.api.uncheck(itemId));
            // Applied only if no newer tick has been issued since - three taps in a second are
            // three requests, and the one that finishes last is not necessarily the one that was
            // asked for last.
            if (this.itemGeneration.get(itemId) === generation) {
                this.mutate(channelId, items => this.upsert(items, updated));
            }
            return true;
        } catch (err) {
            if (this.itemGeneration.get(itemId) === generation) {
                this.mutate(channelId, items => this.upsert(items, before));
            }
            this.toastService.httpError(this.translate.instant('LIST.ERROR_CHECK'), err);
            return false;
        }
    }

    /** Edits text/quantity/note/section/assignee. Own row needs `AddListItems`, anyone else's `ManageLists`. */
    async updateItem(channelId: string, itemId: string, dto: UpdateListItemDto): Promise<boolean> {
        const before = this.stateFor(channelId).items.find(item => item.id === itemId);
        if (!before) return false;

        if (dto.text !== undefined && dto.text.length > LIST_LIMITS.textMaxLength) {
            this.toastService.error(this.translate.instant('LIST.ERROR_TEXT_TOO_LONG',
                {max: LIST_LIMITS.textMaxLength}));
            return false;
        }

        const generation = this.bumpGeneration(itemId);
        this.mutate(channelId, items =>
            items.map(item => item.id === itemId ? this.applyPatch(item, dto) : item));

        try {
            const updated = await firstValueFrom(this.api.update(itemId, dto));
            if (this.itemGeneration.get(itemId) === generation) {
                this.mutate(channelId, items => this.upsert(items, updated));
            }
            return true;
        } catch (err) {
            if (this.itemGeneration.get(itemId) === generation) {
                this.mutate(channelId, items => this.upsert(items, before));
            }
            this.toastService.httpError(this.translate.instant('LIST.ERROR_UPDATE'), err);
            return false;
        }
    }

    async deleteItem(channelId: string, itemId: string): Promise<boolean> {
        const items = this.stateFor(channelId).items;
        const index = items.findIndex(item => item.id === itemId);
        if (index < 0) return false;
        const before = items[index];

        this.bumpGeneration(itemId);
        this.mutate(channelId, current => current.filter(item => item.id !== itemId));

        try {
            await firstValueFrom(this.api.remove(itemId));
            return true;
        } catch (err) {
            // Back at its old index, not appended: a failed delete must look like nothing
            // happened, and re-appending would silently reorder the list instead.
            this.mutate(channelId, current => {
                if (current.some(item => item.id === itemId)) return current;
                const restored = [...current];
                restored.splice(Math.min(index, restored.length), 0, before);
                return restored;
            });
            this.toastService.httpError(this.translate.instant('LIST.ERROR_DELETE'), err);
            return false;
        }
    }

    /**
     * Moves one row, and sends the smallest payload that describes the result.
     *
     * <p>Omitted ids land *after* the ones sent, so the sendable neighbourhood is a **prefix**:
     * everything from the top down to the further of the two indices. Sending only the two rows
     * that swapped would instead teleport them to the head of the list, which is the mistake this
     * rule invites. Below that prefix nothing moved relative to anything, so nothing needs naming
     * - dragging the second row onto the third sends three ids, not five hundred.</p>
     */
    async moveItem(channelId: string, fromIndex: number, toIndex: number): Promise<boolean> {
        const before = this.stateFor(channelId).items;
        if (fromIndex === toIndex) return true;
        if (fromIndex < 0 || fromIndex >= before.length) return false;

        const target = Math.max(0, Math.min(toIndex, before.length - 1));
        const next = [...before];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(target, 0, moved);

        const prefix = next.slice(0, Math.max(fromIndex, target) + 1).map(item => item.id);
        this.patch(channelId, {items: renumberPositions(next)});

        try {
            await firstValueFrom(this.api.reorder(channelId, {itemIds: prefix}));
            return true;
        } catch (err) {
            // Restored by id rather than by wholesale replacement, so a row created or ticked
            // during the failed request is not thrown away with the failed order.
            this.mutate(channelId, current =>
                renumberPositions(reorderByPartialIds(current, before.map(item => item.id))));
            this.toastService.httpError(this.translate.instant('LIST.ERROR_REORDER'), err);
            return false;
        }
    }

    /** "Clear done" - drops every ticked row. Needs `ManageLists`. */
    async clearChecked(channelId: string): Promise<boolean> {
        const before = this.stateFor(channelId).items;
        const remaining = before.filter(item => !item.isChecked);
        if (remaining.length === before.length) return true;

        this.patch(channelId, {items: renumberPositions(remaining)});

        try {
            await firstValueFrom(this.api.clearChecked(channelId));
            return true;
        } catch (err) {
            this.patch(channelId, {items: before});
            this.toastService.httpError(this.translate.instant('LIST.ERROR_CLEAR'), err);
            return false;
        }
    }

    // ── Realtime ────────────────────────────────────────────────────────────
    //
    // Every handler bails on a channel with no state. The alternative - accumulating events into a
    // list that was never fetched - produces a channel showing only what happened since the socket
    // connected, which is worse than showing a spinner until it is opened.

    private onCreated({channelId, item}: ListItemCreated): void {
        if (!this.isTracked(channelId)) return;
        this.mutate(channelId, items => {
            const existing = items.find(row => row.id === item.id) ?? null;
            return this.upsert(items, normalizeCreatedItem(item, existing));
        });
    }

    private onUpdated({channelId, item}: ListItemUpdated): void {
        if (!this.isTracked(channelId)) return;
        // Only for rows already held. An update for an unknown id is a row this client never
        // fetched (created while a load was in flight); the create event places it, not this one.
        this.mutate(channelId, items =>
            items.some(row => row.id === item.id) ? this.upsert(items, item) : items);
    }

    /**
     * The other phone in the shop.
     *
     * <p>The event carries the whole row, so this assigns `isChecked` from it rather than flipping
     * anything. That is not a style preference: the server broadcasts nothing at all when a tick
     * was a no-op, so the events a client sees are not a complete sequence of transitions and
     * cannot be replayed as one.</p>
     */
    private onChecked({channelId, item}: ListItemChecked): void {
        if (!this.isTracked(channelId)) return;
        // Our own echo bumps the generation too, so a response still in flight for this row is
        // now stale and will not be allowed to overwrite the newer broadcast.
        this.bumpGeneration(item.id);
        this.mutate(channelId, items =>
            items.some(row => row.id === item.id) ? this.upsert(items, item) : items);
    }

    private onDeleted({channelId, itemId}: ListItemDeleted): void {
        if (!this.isTracked(channelId)) return;
        this.bumpGeneration(itemId);
        this.mutate(channelId, items => items.filter(item => item.id !== itemId));
    }

    private onReordered({channelId, itemIds}: ListItemsReordered): void {
        if (!this.isTracked(channelId)) return;
        // The broadcast echoes exactly what the reordering client sent, so it is partial in the
        // same way - the same rule applies to it as to the request.
        this.mutate(channelId, items => renumberPositions(reorderByPartialIds(items, itemIds)));
    }

    private onCleared({channelId}: ListCleared): void {
        if (!this.isTracked(channelId)) return;
        // `removedCount` is not used to decide what goes: the checked set is the definition, and
        // trusting a count against a list this client may not have fully caught up on would drop
        // the wrong rows.
        this.mutate(channelId, items => renumberPositions(items.filter(item => !item.isChecked)));
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private isTracked(channelId: string): boolean {
        return channelId in this.stateByChannel();
    }

    private ownUserId(): string {
        return this.profileService.ownProfile()?.userId ?? '';
    }

    private bumpGeneration(itemId: string): number {
        const next = (this.itemGeneration.get(itemId) ?? 0) + 1;
        this.itemGeneration.set(itemId, next);
        return next;
    }

    /**
     * The optimistic guess at what the PATCH will do, applied the way the server applies it.
     *
     * <p>Not a plain spread: `clearAssignee` is a wire flag rather than a field, so spreading the
     * dto would put a `clearAssignee: true` key on the row and leave `assigneeUserId` untouched -
     * the row would show the old assignee until the response landed and contradicted it.</p>
     */
    private applyPatch(item: ListItem, dto: UpdateListItemDto): ListItem {
        const {clearAssignee, ...fields} = dto;
        const next: ListItem = {...item, ...fields};
        if (clearAssignee) next.assigneeUserId = null;
        return next;
    }

    /** Replaces the row with this id in place, or appends it. Order is never disturbed by an update. */
    private upsert(items: readonly ListItem[], item: ListItem): ListItem[] {
        const index = items.findIndex(row => row.id === item.id);
        if (index < 0) return [...items, {...item, position: items.length}];
        const next = [...items];
        next[index] = item;
        return next;
    }

    private draftItem(channelId: string, dto: CreateListItemDto, position: number): ListItem {
        return {
            id: `${TEMP_ID_PREFIX}${++this.tempCounter}`,
            channelId,
            text: dto.text,
            quantity: dto.quantity ?? null,
            note: dto.note ?? null,
            section: dto.section ?? null,
            assigneeUserId: dto.assigneeUserId ?? null,
            addedByUserId: this.ownUserId(),
            isChecked: false,
            checkedAt: null,
            checkedByUserId: null,
            position,
            sourcePantryItemId: null,
            createdAt: new Date().toISOString(),
        };
    }

    private mutate(channelId: string, fn: (items: ListItem[]) => ListItem[]): void {
        const state = this.stateByChannel()[channelId];
        if (!state) return;
        this.patch(channelId, {items: fn(state.items)});
    }

    private patch(channelId: string, patch: Partial<ListChannelState>): void {
        this.stateByChannel.update(all => ({
            ...all,
            [channelId]: {...(all[channelId] ?? EMPTY_STATE), ...patch},
        }));
    }
}
