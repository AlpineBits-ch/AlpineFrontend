import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {PantryBarcode, PantryConfig, PantryItem, ScanPantryItemResult} from '../dtos/response/pantry.dto';
import {
    ConsumePantryItemDto,
    CreatePantryItemDto,
    RestockPantryItemDto,
    ScanPantryItemDto,
    UpdatePantryConfigDto,
    UpdatePantryItemDto,
} from '../dtos/request/pantry.dto';
import {PantryStore} from '../stores/pantry.store';

/** The house-wide expiring view's default window: none, meaning every pantry answers with its own `expiryWarningDays`. A number here overrides every pantry at once. */
export const DEFAULT_EXPIRING_DAYS: number | null = null;

/** What the badge column falls back to for a pantry whose config has not arrived yet. */
export const DEFAULT_EXPIRY_WARNING_DAYS = 3;

/** The view-facing shape of {@link PantryStore}. State and realtime both live in the store. */
@Injectable({providedIn: 'root'})
export class PantryService {
    private store = inject(PantryStore);

    // ── Reads ────────────────────────────────────────────────────────────────

    itemsFor(channelId: string): PantryItem[] {
        return this.store.stockFor(channelId)();
    }

    configFor(channelId: string): PantryConfig | undefined {
        return this.store.configByChannel()[channelId];
    }

    loading(channelId: string): boolean {
        return this.store.stockLoading(channelId);
    }

    loadError(channelId: string): boolean {
        return this.store.stockError(channelId) !== null;
    }

    /** True once a fetch for this pantry has come back successfully. */
    hasLoaded(channelId: string): boolean {
        return this.store.stockLoaded(channelId);
    }

    expiringFor(guildId: string): PantryItem[] {
        return this.store.expiringFor(guildId)();
    }

    expiringBusy(guildId: string): boolean {
        return this.store.expiringLoading(guildId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per pantry for the session; call it on every open. */
    loadFor(channelId: string): void {
        this.store.loadFor(channelId);
    }

    /** Forces a re-read of both halves. Used on retry and after a 403 is cleared. */
    refresh(channelId: string): void {
        this.store.refresh(channelId);
    }

    /** The house-wide expiring answer, served from cache unless the window changed or an item event marked it stale. A null `days` lets every pantry apply its own `expiryWarningDays`. */
    loadExpiring(guildId: string, days: number | null = DEFAULT_EXPIRING_DAYS, force = false): void {
        this.store.loadExpiring(guildId, {arg: days, force});
    }

    // ── Writes. Each applies the server's echo locally; both key on the item id, so the
    //    realtime event that follows is idempotent with it. ─────────────────────────

    addItem(channelId: string, dto: CreatePantryItemDto): Observable<PantryItem> {
        return this.store.addItem(channelId, dto);
    }

    /** @param channelId the pantry the item belongs to. Not in the URL, since the item id is global, but needed to know which cached list to patch. */
    updateItem(channelId: string, itemId: string, dto: UpdatePantryItemDto): Observable<PantryItem> {
        return this.store.updateItem(channelId, itemId, dto);
    }

    deleteItem(channelId: string, itemId: string): Observable<void> {
        return this.store.deleteItem(channelId, itemId);
    }

    saveConfig(channelId: string, dto: UpdatePantryConfigDto): Observable<PantryConfig> {
        return this.store.saveConfig(channelId, dto);
    }

    /** Applied locally after a write, and by the config editor's own optimistic patch. */
    putConfig(config: PantryConfig): void {
        this.store.putConfig(config);
    }

    // ── Capture ──────────────────────────────────────────────────────────────
    //
    // Three one-tap writes.

    /** Scans a code into this pantry: tops up the row if it is there, creates it if not. `created` separates a new row from a top-up; only `learned` is worth interrupting anybody about. */
    scan(guildId: string, channelId: string, dto: ScanPantryItemDto): Observable<ScanPantryItemResult> {
        return this.store.scan(guildId, channelId, dto);
    }

    /** One-tap "used it up". Runs the server's low-stock loop, so the same alerts fire. */
    consume(
        guildId: string,
        channelId: string,
        itemId: string,
        dto: ConsumePantryItemDto = {},
    ): Observable<PantryItem> {
        return this.store.consume(guildId, channelId, itemId, dto);
    }

    /** One-tap "put some back". Also ticks off the shopping-list line the pantry created. */
    restock(
        guildId: string,
        channelId: string,
        itemId: string,
        dto: RestockPantryItemDto = {},
    ): Observable<PantryItem> {
        return this.store.restock(guildId, channelId, itemId, dto);
    }

    /** The codes this guild has learned. Uncached, because it backs a search-as-you-type field and every answer is query-specific. */
    barcodes(guildId: string, query?: string | null): Observable<PantryBarcode[]> {
        return this.store.barcodes(guildId, query);
    }
}
