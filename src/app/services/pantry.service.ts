import {inject, Injectable, signal} from '@angular/core';
import {Observable, tap} from 'rxjs';
import {
    PantryConfig,
    PantryItem,
    PantryItemCreated,
    PantryItemDeleted,
    PantryItemUpdated,
} from '../dtos/response/pantry.dto';
import {CreatePantryItemDto, UpdatePantryConfigDto, UpdatePantryItemDto} from '../dtos/request/pantry.dto';
import {PantryApiService} from './pantry-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * The look-ahead used by the house-wide expiring view until the user picks another one.
 * Matches the example in the API guide; it is a query window, not a pantry's own badge
 * threshold, which is why it does not read `expiryWarningDays` from anywhere.
 */
export const DEFAULT_EXPIRING_DAYS = 3;

/**
 * What the badge column falls back to for a pantry whose config has not arrived yet. Only
 * ever affects the moment between opening a pantry and its config landing - once the real
 * value is in, every row re-derives from it.
 */
export const DEFAULT_EXPIRY_WARNING_DAYS = 3;

/**
 * Pantry stock and per-pantry config, cached per channel, kept fresh by realtime rather
 * than by refetching.
 *
 * <p>Two scopes live here and they are deliberately not the same cache. `itemsByChannel`
 * is one pantry - one fridge - and is what the channel view renders. `expiringByGuild` is
 * the house-wide "what needs eating" answer, which spans every pantry the caller can see
 * and therefore cannot be assembled by filtering the per-channel caches: those only hold
 * pantries this session has actually opened.</p>
 *
 * <p>Nothing here implements the restock loop. The server appends to the shopping list and
 * stamps `restockedAt`; all this service does is make sure the stamp - and its release -
 * reach the UI promptly, which is the whole reason the three item events are wired.</p>
 */
@Injectable({providedIn: 'root'})
export class PantryService {
    private readonly itemsByChannel = signal<Record<string, PantryItem[]>>({});
    private readonly configByChannel = signal<Record<string, PantryConfig>>({});
    private readonly loadingChannels = signal<Record<string, boolean>>({});
    /** Set when a pantry's item fetch failed, so the view can tell "empty" from "broken". */
    private readonly errorChannels = signal<Record<string, boolean>>({});

    private readonly expiringByGuild = signal<Record<string, PantryItem[]>>({});
    private readonly expiringLoading = signal<Record<string, boolean>>({});
    /**
     * Guilds whose expiring answer is known to be out of date because an item changed
     * somewhere. Not repaired eagerly: the view is not usually on screen, and a refetch per
     * event would turn one person restocking a shelf into a burst of guild-wide queries.
     */
    private readonly expiringStale = new Set<string>();

    /** Pantries a fetch has already been issued for, so `loadFor` is safe on every open. */
    private readonly requested = new Set<string>();

    private api = inject(PantryApiService);
    private realtime = inject(RealtimeConnectionService);

    constructor() {
        // Registered exactly once, here, because `RealtimeConnectionService.on` does not
        // deduplicate - a second registration delivers every event twice. `on` is safe
        // before `start`; early handlers are replayed onto the connection when it builds.
        //
        // `guild.ListItemCreated` is *not* registered. An automatic restock emits it on the
        // list channel, where the Lists module already listens; picking it up here as well
        // would double every list item in the app.
        this.realtime.on('guild.PantryItemCreated', (d: PantryItemCreated) => this.onItemUpserted(d));
        this.realtime.on('guild.PantryItemUpdated', (d: PantryItemUpdated) => this.onItemUpserted(d));
        this.realtime.on('guild.PantryItemDeleted', (d: PantryItemDeleted) => this.onItemDeleted(d));
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    itemsFor(channelId: string): PantryItem[] {
        return this.itemsByChannel()[channelId] ?? [];
    }

    configFor(channelId: string): PantryConfig | undefined {
        return this.configByChannel()[channelId];
    }

    loading(channelId: string): boolean {
        return this.loadingChannels()[channelId] ?? false;
    }

    loadError(channelId: string): boolean {
        return this.errorChannels()[channelId] ?? false;
    }

    /** True once a fetch for this pantry has come back, successfully or not. */
    hasLoaded(channelId: string): boolean {
        return channelId in this.itemsByChannel();
    }

    expiringFor(guildId: string): PantryItem[] {
        return this.expiringByGuild()[guildId] ?? [];
    }

    expiringBusy(guildId: string): boolean {
        return this.expiringLoading()[guildId] ?? false;
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per pantry for the session; call it on every open. */
    loadFor(channelId: string): void {
        if (this.requested.has(channelId)) return;
        this.requested.add(channelId);
        this.refresh(channelId);
    }

    /** Forces a re-read of both halves. Used on retry and after a 403 is cleared. */
    refresh(channelId: string): void {
        this.loadingChannels.update(m => ({...m, [channelId]: true}));

        this.api.listItems(channelId).subscribe({
            next: items => {
                this.itemsByChannel.update(m => ({...m, [channelId]: this.sorted(items)}));
                this.loadingChannels.update(m => ({...m, [channelId]: false}));
                this.errorChannels.update(m => ({...m, [channelId]: false}));
            },
            error: () => {
                // Left absent rather than set to `[]`: an empty pantry and a pantry we were
                // refused are opposite things, and `hasLoaded` is what the view uses to tell
                // them apart before deciding whether to blame permissions or the module.
                this.loadingChannels.update(m => ({...m, [channelId]: false}));
                this.errorChannels.update(m => ({...m, [channelId]: true}));
            },
        });

        // Config failing must not take the stock list down with it: a pantry with an
        // unreadable config still lists what's in it, just without restock wiring shown.
        this.api.getConfig(channelId).subscribe({
            next: config => this.putConfig(config),
            error: () => undefined,
        });
    }

    /**
     * The house-wide expiring answer. Refetched when the window changes or the cache was
     * marked stale by an item event; otherwise served from cache, because this view is
     * opened and closed repeatedly while shopping.
     */
    loadExpiring(guildId: string, days = DEFAULT_EXPIRING_DAYS, force = false): void {
        if (this.expiringBusy(guildId)) return;
        if (!force && !this.expiringStale.has(guildId) && guildId in this.expiringByGuild()) return;

        this.expiringLoading.update(m => ({...m, [guildId]: true}));
        this.api.expiring(guildId, days).subscribe({
            next: items => {
                this.expiringStale.delete(guildId);
                this.expiringByGuild.update(m => ({...m, [guildId]: this.sortedByExpiry(items)}));
                this.expiringLoading.update(m => ({...m, [guildId]: false}));
            },
            error: () => {
                this.expiringLoading.update(m => ({...m, [guildId]: false}));
            },
        });
    }

    // ── Writes. Each applies the server's echo locally rather than waiting for the
    //    realtime event - the two are idempotent with each other because both key on
    //    the item id, and the writer should not watch their own edit lag. ───────────

    addItem(channelId: string, dto: CreatePantryItemDto): Observable<PantryItem> {
        return this.api.createItem(channelId, dto).pipe(tap(item => this.upsert(channelId, item)));
    }

    /**
     * @param channelId the pantry the item belongs to. Not in the URL - the item id is
     *        global - but needed to know which cached list to patch.
     */
    updateItem(channelId: string, itemId: string, dto: UpdatePantryItemDto): Observable<PantryItem> {
        return this.api.updateItem(itemId, dto).pipe(tap(item => this.upsert(channelId, item)));
    }

    deleteItem(channelId: string, itemId: string): Observable<void> {
        return this.api.deleteItem(itemId).pipe(tap(() => this.removeLocally(channelId, itemId)));
    }

    saveConfig(channelId: string, dto: UpdatePantryConfigDto): Observable<PantryConfig> {
        return this.api.putConfig(channelId, dto).pipe(tap(config => this.putConfig(config)));
    }

    /** Applied locally after a write, and by the config editor's own optimistic patch. */
    putConfig(config: PantryConfig): void {
        this.configByChannel.update(m => ({...m, [config.channelId]: config}));
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    /**
     * Created and Updated share a handler on purpose. Both carry the full item, both are
     * keyed by id, and treating a create as an upsert is what makes the writer's own echo
     * harmless after their optimistic apply. It also means an Updated that arrives for a
     * row we never saw created - because the socket dropped in between - still lands.
     *
     * <p>The one thing this must never do is remember anything: `restockedAt` is read off
     * the payload every time, so the release the server sends when an item is bought
     * un-badges the row with no state to clear.</p>
     */
    private onItemUpserted(payload: PantryItemCreated | PantryItemUpdated): void {
        this.expiringStale.add(payload.guildId);
        this.patchExpiring(payload.guildId, list =>
            list.map(i => i.id === payload.item.id ? payload.item : i));

        // Events for pantries nobody has opened are dropped rather than seeding a
        // one-item list: `loadFor` will fetch the authoritative set when someone opens it,
        // and a partial list that reports itself as loaded is worse than no list.
        if (!(payload.channelId in this.itemsByChannel())) return;
        this.upsert(payload.channelId, payload.item);
    }

    private onItemDeleted(payload: PantryItemDeleted): void {
        this.expiringStale.add(payload.guildId);
        this.patchExpiring(payload.guildId, list => list.filter(i => i.id !== payload.itemId));
        this.removeLocally(payload.channelId, payload.itemId);
    }

    // ── Cache plumbing ───────────────────────────────────────────────────────

    private upsert(channelId: string, item: PantryItem): void {
        this.itemsByChannel.update(m => {
            const list = m[channelId] ?? [];
            const next = list.some(i => i.id === item.id)
                ? list.map(i => i.id === item.id ? item : i)
                : [...list, item];
            return {...m, [channelId]: this.sorted(next)};
        });
    }

    private removeLocally(channelId: string, itemId: string): void {
        this.itemsByChannel.update(m => {
            if (!m[channelId]) return m;
            return {...m, [channelId]: m[channelId].filter(i => i.id !== itemId)};
        });
    }

    /** Only touches a guild already in the cache - see the drop rule in `onItemUpserted`. */
    private patchExpiring(guildId: string, fn: (list: PantryItem[]) => PantryItem[]): void {
        this.expiringByGuild.update(m => {
            if (!m[guildId]) return m;
            return {...m, [guildId]: fn(m[guildId])};
        });
    }

    /**
     * Name order, case-insensitive. Deliberately *not* urgency order: rows move between
     * `low`, `listed` and `ok` several times a week, and a list that reorders itself every
     * time someone puts a bottle back is unreadable. Urgency is carried by the badge, and
     * grouping is the view's decision.
     */
    private sorted(items: PantryItem[]): PantryItem[] {
        return [...items].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The expiring view is the one place urgency *is* the order - soonest first. */
    private sortedByExpiry(items: PantryItem[]): PantryItem[] {
        return [...items].sort((a, b) => {
            const at = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bt = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
            return at - bt || a.name.localeCompare(b.name);
        });
    }
}
