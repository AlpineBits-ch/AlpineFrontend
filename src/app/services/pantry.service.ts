import {inject, Injectable, signal} from '@angular/core';
import {Observable, tap} from 'rxjs';
import {
    PantryBarcode,
    PantryConfig,
    PantryItem,
    PantryItemCreated,
    PantryItemDeleted,
    PantryItemUpdated,
    ScanPantryItemResult,
} from '../dtos/response/pantry.dto';
import {
    ConsumePantryItemDto,
    CreatePantryItemDto,
    RestockPantryItemDto,
    ScanPantryItemDto,
    UpdatePantryConfigDto,
    UpdatePantryItemDto,
} from '../dtos/request/pantry.dto';
import {PantryApiService} from './pantry-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/** The house-wide expiring view's default window: none, meaning every pantry answers with its own `expiryWarningDays`. A number here overrides every pantry at once. */
export const DEFAULT_EXPIRING_DAYS: number | null = null;

/** What the badge column falls back to for a pantry whose config has not arrived yet. */
export const DEFAULT_EXPIRY_WARNING_DAYS = 3;

/** Pantry stock and per-pantry config, cached per channel, kept fresh by realtime rather than by refetching. */
@Injectable({providedIn: 'root'})
export class PantryService {
    private readonly itemsByChannel = signal<Record<string, PantryItem[]>>({});
    private readonly configByChannel = signal<Record<string, PantryConfig>>({});
    private readonly loadingChannels = signal<Record<string, boolean>>({});
    /** Set when a pantry's item fetch failed, so the view can tell "empty" from "broken". */
    private readonly errorChannels = signal<Record<string, boolean>>({});

    private readonly expiringByGuild = signal<Record<string, PantryItem[]>>({});
    private readonly expiringLoading = signal<Record<string, boolean>>({});
    /** Guilds whose expiring answer is out of date because an item changed somewhere. Repaired lazily, never per event. */
    private readonly expiringStale = new Set<string>();

    /** Pantries a fetch has already been issued for, so `loadFor` is safe on every open. */
    private readonly requested = new Set<string>();

    private api = inject(PantryApiService);
    private realtime = inject(RealtimeConnectionService);

    constructor() {
        // Registered exactly once: `RealtimeConnectionService.on` does not deduplicate, and a second registration delivers every event twice.
        // `guild.ListItemCreated` is deliberately not registered; the Lists module already listens, and picking it up here would double every list item in the app.
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
                // Left absent rather than set to `[]`: an empty pantry and a pantry we were refused are opposite things, and `hasLoaded` tells them apart.
                this.loadingChannels.update(m => ({...m, [channelId]: false}));
                this.errorChannels.update(m => ({...m, [channelId]: true}));
            },
        });

        // Config failing must not take the stock list down with it.
        this.api.getConfig(channelId).subscribe({
            next: config => this.putConfig(config),
            error: () => undefined,
        });
    }

    /** The house-wide expiring answer, served from cache unless the window changed or an item event marked it stale. A null `days` lets every pantry apply its own `expiryWarningDays`. */
    loadExpiring(guildId: string, days: number | null = DEFAULT_EXPIRING_DAYS, force = false): void {
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

    // ── Writes. Each applies the server's echo locally; both key on the item id, so the
    //    realtime event that follows is idempotent with it. ─────────────────────────

    addItem(channelId: string, dto: CreatePantryItemDto): Observable<PantryItem> {
        return this.api.createItem(channelId, dto).pipe(tap(item => this.upsert(channelId, item)));
    }

    /** @param channelId the pantry the item belongs to. Not in the URL, since the item id is global, but needed to know which cached list to patch. */
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

    // ── Capture ──────────────────────────────────────────────────────────────
    //
    // Three one-tap writes.

    /** Scans a code into this pantry: tops up the row if it is there, creates it if not. `created` separates a new row from a top-up; only `learned` is worth interrupting anybody about. */
    scan(guildId: string, channelId: string, dto: ScanPantryItemDto): Observable<ScanPantryItemResult> {
        return this.api.scan(channelId, dto).pipe(tap(result => {
            this.upsert(channelId, result.item);
            // A scan can carry an expiry, and the expiring view is keyed on the guild rather than the channel, which is why `guildId` is a parameter here.
            this.expiringStale.add(guildId);
        }));
    }

    /** One-tap "used it up". Runs the server's low-stock loop, so the same alerts fire. */
    consume(
        guildId: string,
        channelId: string,
        itemId: string,
        dto: ConsumePantryItemDto = {},
    ): Observable<PantryItem> {
        return this.api.consume(itemId, dto).pipe(tap(item => {
            this.upsert(channelId, item);
            this.expiringStale.add(guildId);
        }));
    }

    /** One-tap "put some back". Also ticks off the shopping-list line the pantry created. */
    restock(
        guildId: string,
        channelId: string,
        itemId: string,
        dto: RestockPantryItemDto = {},
    ): Observable<PantryItem> {
        return this.api.restock(itemId, dto).pipe(tap(item => {
            this.upsert(channelId, item);
            this.expiringStale.add(guildId);
        }));
    }

    /** The codes this guild has learned. Uncached, because it backs a search-as-you-type field and every answer is query-specific. */
    barcodes(guildId: string, query?: string | null): Observable<PantryBarcode[]> {
        return this.api.barcodes(guildId, query);
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    /** Created and Updated share a handler: both carry the full item and key by id. It must remember nothing, so `restockedAt` is read off the payload every time and the server's release un-badges the row with no state to clear. */
    private onItemUpserted(payload: PantryItemCreated | PantryItemUpdated): void {
        this.expiringStale.add(payload.guildId);
        this.patchExpiring(payload.guildId, list =>
            list.map(i => i.id === payload.item.id ? payload.item : i));

        // Events for pantries nobody has opened are dropped rather than seeding a partial list that reports itself as loaded.
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

    /** Name order, case-insensitive. Deliberately not urgency order: urgency is carried by the badge, and grouping is the view's decision. */
    private sorted(items: PantryItem[]): PantryItem[] {
        return [...items].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The expiring view is the one place urgency is the order: soonest first. */
    private sortedByExpiry(items: PantryItem[]): PantryItem[] {
        return [...items].sort((a, b) => {
            const at = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
            const bt = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
            return at - bt || a.name.localeCompare(b.name);
        });
    }
}
