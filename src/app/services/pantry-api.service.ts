import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {PantryBarcode, PantryConfig, PantryItem, ScanPantryItemResult} from '../dtos/response/pantry.dto';
import {
    ConsumePantryItemDto,
    CreatePantryItemDto,
    RestockPantryItemDto,
    ScanPantryItemDto,
    UpdatePantryConfigDto,
    UpdatePantryItemDto,
} from '../dtos/request/pantry.dto';

/**
 * The pantry HTTP surface, and nothing else. State, caching and realtime reconciliation
 * live in {@link import('./pantry.service').PantryService}.
 *
 * <p>The doubled `guild` segment is correct: the gateway strips one before forwarding, so
 * the public path really is `/api/v1/guild/channels/{id}/pantry-items`.</p>
 *
 * <p>Note the two different scopes. Items, config and creation are addressed **per
 * channel** - one pantry is one location. Item mutation is addressed by **item id alone**,
 * with no channel in the path, because an item never moves between pantries. And
 * {@link expiring} is addressed **per guild**, which is not an oversight: see its doc.</p>
 */
@Injectable({providedIn: 'root'})
export class PantryApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /** Everything in one pantry. Needs only `ViewChannel`. */
    listItems(channelId: string): Observable<PantryItem[]> {
        return this.http.get<PantryItem[]>(`${this.base}/channels/${channelId}/pantry-items`);
    }

    /**
     * Adds stock. Requires `ManagePantry`.
     *
     * <p>If the new quantity is already at or below `lowThreshold` and the pantry has a
     * restock list, the server appends it and the echoed item comes back with
     * `restockedAt` already set - so the row can be `listed` the instant it is created.</p>
     */
    createItem(channelId: string, dto: CreatePantryItemDto): Observable<PantryItem> {
        return this.http.post<PantryItem>(`${this.base}/channels/${channelId}/pantry-items`, dto);
    }

    /**
     * Edits stock. Requires `ManagePantry`. No channel in the path - the item id is global.
     *
     * <p>This is the call that drives the whole restock loop: a quantity crossing the
     * threshold downward is what makes the server append to the list and stamp
     * `restockedAt`, and a quantity crossing back up is what releases it. Both arrive back
     * as `guild.PantryItemUpdated`, so the caller does not have to reason about which
     * happened.</p>
     *
     * <p>Clearing a threshold or an expiry is `clearLowThreshold` / `clearExpiresAt`, never a
     * null value - the server reads a null as "leave alone". See {@link UpdatePantryItemDto}.</p>
     */
    updateItem(itemId: string, dto: UpdatePantryItemDto): Observable<PantryItem> {
        return this.http.patch<PantryItem>(`${this.base}/pantry-items/${itemId}`, dto);
    }

    /** Removes stock. Requires `ManagePantry`. */
    deleteItem(itemId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/pantry-items/${itemId}`);
    }

    /**
     * What needs eating, across **every pantry in the guild the caller can see**.
     *
     * <p>Guild-scoped on purpose - "what's about to go off" is a question about the house,
     * not about the fridge - so this must never be rendered as one pantry's list. Results
     * are filtered per channel by `ViewChannel` server-side, which is what lets a guest
     * with access to one pantry ask the question without enumerating a private one.</p>
     *
     * <p><b>Omit `days` and each pantry answers with its own `expiryWarningDays`</b>, which is
     * almost always what the house-wide view wants: a freezer set to 14 days and a fridge set to 2
     * are both right in the same response, and neither is right under one flat number. This used to
     * ignore the config entirely and ask for a flat three days for everything.</p>
     *
     * @param days a single look-ahead window that **overrides every pantry at once**. For the
     *        "what goes off this month" question and nothing else - passing the old default of 3
     *        here is not the same as passing nothing.
     */
    expiring(guildId: string, days?: number | null): Observable<PantryItem[]> {
        const params = days == null ? new HttpParams() : new HttpParams().set('days', days);
        return this.http.get<PantryItem[]>(`${this.base}/guilds/${guildId}/pantry/expiring`, {params});
    }

    getConfig(channelId: string): Observable<PantryConfig> {
        return this.http.get<PantryConfig>(`${this.base}/channels/${channelId}/pantry/config`);
    }

    /**
     * Full replace, not a patch - `expiryWarningDays` is always sent. Requires `ManagePantry`.
     *
     * <p>The restock list is the exception and is switched off with `clearRestockList: true`
     * rather than a null id, for the reason in {@link UpdatePantryConfigDto}.</p>
     */
    putConfig(channelId: string, dto: UpdatePantryConfigDto): Observable<PantryConfig> {
        return this.http.put<PantryConfig>(`${this.base}/channels/${channelId}/pantry/config`, dto);
    }

    // ── Capture ──────────────────────────────────────────────────────────────
    //
    // Three calls, all `ManagePantry`, all designed to cost one tap. Keeping a decimal quantity
    // correct by hand is itself a chore, and it is the one houses stop doing first.

    /**
     * Scans a code into this pantry: tops the row up if it exists, creates it if not.
     *
     * <p><b>The guild learns its own products and there is no third-party lookup.</b> The first
     * scan of an unknown code needs a `name`; every scan after that autofills from what the house
     * itself recorded. `learned: true` in the answer is the one moment worth confirming with the
     * user - be silent on every other one.</p>
     */
    scan(channelId: string, dto: ScanPantryItemDto): Observable<ScanPantryItemResult> {
        return this.http.post<ScanPantryItemResult>(
            `${this.base}/channels/${channelId}/pantry-items/scan`,
            dto,
        );
    }

    /**
     * "Used it up." Runs the same low-stock and restock loop an edit does, so the same alerts fire.
     *
     * <p>`all: true` rather than an amount for the common case: "that was the last of it" cannot be
     * expressed as a number without first knowing the exact stock, which is the arithmetic the tap
     * exists to remove.</p>
     */
    consume(itemId: string, dto: ConsumePantryItemDto = {}): Observable<PantryItem> {
        return this.http.post<PantryItem>(`${this.base}/pantry-items/${itemId}/consume`, dto);
    }

    /** "Put some back." Also ticks off the shopping-list line the pantry created for it. */
    restock(itemId: string, dto: RestockPantryItemDto = {}): Observable<PantryItem> {
        return this.http.post<PantryItem>(`${this.base}/pantry-items/${itemId}/restock`, dto);
    }

    /**
     * The codes this guild has learned, for completing a manually typed one.
     *
     * <p>Guild-scoped, not per pantry: a product learned in the cellar is the same product in the
     * fridge, and making somebody re-teach it per location is how the learning stops being worth
     * it.</p>
     */
    barcodes(guildId: string, query?: string | null): Observable<PantryBarcode[]> {
        const params = query ? new HttpParams().set('q', query) : new HttpParams();
        return this.http.get<PantryBarcode[]>(`${this.base}/guilds/${guildId}/pantry/barcodes`, {params});
    }
}
