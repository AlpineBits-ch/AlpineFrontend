import {effect, inject, Injectable, signal, untracked} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {
    HOME_STATUS_MAX_MINUTES,
    HomeStatusChanged,
    HomeStatusDto,
    isHomeStatusSet,
    normalizeHomeStatus,
    SetHomeStatusDto,
} from '../dtos/response/home-status.dto';
import {HomeStatusApiService} from './home-status-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * How often the board re-checks which statuses are still live.
 *
 * <p>One timer for the whole app rather than one per entry: expiries are hours out and nobody is
 * watching the second an "Out until 18:00" turns over, so a single cheap sweep is the right shape.
 * A per-entry `setTimeout` would mean n timers, each of which has to be cancelled on every update,
 * every clear and every guild switch - all to move a row thirty seconds sooner.</p>
 */
const DECAY_TICK_MS = 30_000;

/**
 * Who is in the flat, per guild.
 *
 * <p><b>Not connection presence.</b> {@link import('./messaging-websocket.service').MessagingWebsocketService}
 * owns `presence.UserOnline` / `presence.UserOffline`, which say whether someone's app is
 * connected. This says whether they are home, and it is asserted by hand rather than derived. The
 * two are rendered as separate things on purpose; see the home-status board.</p>
 *
 * <p><b>It decays.</b> `expiresAt` is authoritative and the server never hands back an expired
 * entry, so the only way this store can lie is by holding one after its expiry. {@link statuses}
 * therefore filters against a ticking clock rather than trusting whatever the last fetch said - a
 * board that still claims someone is asleep three days later is worse than no board.</p>
 */
@Injectable({providedIn: 'root'})
export class HomeStatusService {
    private api = inject(HomeStatusApiService);
    private realtime = inject(RealtimeConnectionService);

    /** guildId -> userId -> status. Raw: may contain entries that have since expired. */
    private readonly _byGuild = signal<ReadonlyMap<string, ReadonlyMap<string, HomeStatusDto>>>(new Map());

    /**
     * The clock {@link statuses} filters against, moved by the sweep below.
     *
     * <p>A signal rather than a `Date.now()` call inside the computed: a computed caches, so a
     * non-reactive clock would freeze at whatever the first read saw and nothing would ever
     * expire.</p>
     */
    private readonly nowMs = signal(Date.now());

    /** Guilds a fetch is in flight for or has already completed, so the board loads once. */
    private readonly loaded = new Set<string>();

    /** Guilds whose first fetch is still outstanding. */
    private readonly _loading = signal<ReadonlySet<string>>(new Set());

    /**
     * Guilds whose `GET` came back `403`.
     *
     * <p>Per the module contract that is far more likely to mean the Presence module is off than
     * that this member is forbidden, and the two are indistinguishable from here - so the board
     * renders nothing at all rather than a denial. Callers should already be gating on the
     * `Presence` flag; this is the backstop for a guild whose flags say otherwise.</p>
     */
    private readonly _unavailable = signal<ReadonlySet<string>>(new Set());

    private sweep?: ReturnType<typeof setInterval>;

    constructor() {
        // Exactly once, in a root singleton's constructor: `RealtimeConnectionService.on` does not
        // deduplicate, so a second registration would apply every event twice - which for a clear
        // is harmless and for a set is not. `on` is safe before `start`.
        this.realtime.on('guild.HomeStatusChanged', (d: HomeStatusChanged) => this.onChanged(d));

        // The sweep runs only while something could expire. With no statuses anywhere there is
        // nothing to recompute, and a timer ticking through an empty app is pure churn.
        effect(() => {
            const anything = [...this._byGuild().values()].some(m => m.size > 0);
            untracked(() => (anything ? this.startSweep() : this.stopSweep()));
        });
    }

    /** Live statuses for one guild, newest expiry last. Expired entries are never included. */
    statuses(guildId: string): HomeStatusDto[] {
        const now = this.nowMs();
        const map = this._byGuild().get(guildId);
        if (!map) return [];
        return [...map.values()].filter(s => Date.parse(s.expiresAt) > now);
    }

    /** The caller's own live status in a guild, or null - which is also "expired" and "never set". */
    own(guildId: string, ownUserId: string | null | undefined): HomeStatusDto | null {
        if (!ownUserId) return null;
        return this.statuses(guildId).find(s => s.userId === ownUserId) ?? null;
    }

    /** True once a `403` proved the module is off (or invisible) for this guild. */
    isUnavailable(guildId: string): boolean {
        return this._unavailable().has(guildId);
    }

    /** Whether a guild's first fetch is still outstanding, so the board can hold its empty state. */
    isLoading(guildId: string): boolean {
        return this._loading().has(guildId);
    }

    /**
     * Fetches a guild's board once.
     *
     * <p>Idempotent per guild for the lifetime of the app: realtime keeps it current afterwards, so
     * re-opening the member list is not a reason to re-ask. `force` exists for the reconnect case,
     * where events fired while the socket was down were simply never delivered.</p>
     */
    async ensureLoaded(guildId: string, force = false): Promise<void> {
        if (!force && this.loaded.has(guildId)) return;
        if (this._unavailable().has(guildId)) return;
        this.loaded.add(guildId);
        this._loading.update(s => new Set(s).add(guildId));
        try {
            const rows = await firstValueFrom(this.api.list(guildId));
            const map = new Map<string, HomeStatusDto>();
            for (const row of rows ?? []) {
                const status = normalizeHomeStatus(row);
                if (status) map.set(status.userId, status);
            }
            this.replaceGuild(guildId, map);
        } catch (err) {
            if (err instanceof HttpErrorResponse && err.status === 403) {
                this._unavailable.update(s => new Set(s).add(guildId));
            } else {
                // A transient failure must not pin the guild as loaded, or the board stays empty
                // until the app restarts.
                this.loaded.delete(guildId);
            }
        } finally {
            this._loading.update(s => {
                const next = new Set(s);
                next.delete(guildId);
                return next;
            });
        }
    }

    /**
     * Sets the caller's own status.
     *
     * <p>Applied optimistically from the response rather than from the request: the server decides
     * `expiresAt`, and a locally-guessed one would be the one thing on the board that decays at the
     * wrong time.</p>
     */
    async set(guildId: string, body: SetHomeStatusDto): Promise<HomeStatusDto | null> {
        const payload: SetHomeStatusDto = {
            kind: body.kind,
            note: body.note?.trim() ? body.note.trim() : null,
        };
        if (body.expiresInMinutes != null) {
            payload.expiresInMinutes = Math.min(
                Math.max(1, Math.round(body.expiresInMinutes)),
                HOME_STATUS_MAX_MINUTES,
            );
        }
        const saved = normalizeHomeStatus(await firstValueFrom(this.api.set(guildId, payload)));
        if (saved) this.upsert(guildId, saved);
        return saved;
    }

    /** Clears the caller's own status. The row goes immediately; the event confirms it. */
    async clear(guildId: string, ownUserId: string): Promise<void> {
        const before = this._byGuild().get(guildId);
        this.remove(guildId, ownUserId);
        try {
            await firstValueFrom(this.api.clear(guildId));
        } catch (err) {
            if (before) this.replaceGuild(guildId, new Map(before));
            throw err;
        }
    }

    // ── Realtime ────────────────────────────────────────────────────────────

    /**
     * `guild.HomeStatusChanged` arrives in **two shapes under one name**: `{guildId, status}` when
     * someone sets or extends one, `{guildId, userId, cleared}` when one is cleared. Neither
     * carries a discriminator field, so they are told apart by whether `status` is there.
     */
    private onChanged(event: HomeStatusChanged): void {
        if (!event?.guildId) return;
        if (isHomeStatusSet(event)) {
            const status = normalizeHomeStatus(event.status);
            if (status) this.upsert(event.guildId, status);
            return;
        }
        if (event.userId) this.remove(event.guildId, event.userId);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private upsert(guildId: string, status: HomeStatusDto): void {
        const map = new Map(this._byGuild().get(guildId) ?? []);
        map.set(status.userId, status);
        this.replaceGuild(guildId, map);
    }

    private remove(guildId: string, userId: string): void {
        const current = this._byGuild().get(guildId);
        if (!current?.has(userId)) return;
        const map = new Map(current);
        map.delete(userId);
        this.replaceGuild(guildId, map);
    }

    private replaceGuild(guildId: string, map: ReadonlyMap<string, HomeStatusDto>): void {
        this._byGuild.update(byGuild => {
            const next = new Map(byGuild);
            next.set(guildId, map);
            return next;
        });
    }

    private startSweep(): void {
        if (this.sweep) return;
        this.sweep = setInterval(() => this.tick(), DECAY_TICK_MS);
    }

    private stopSweep(): void {
        if (!this.sweep) return;
        clearInterval(this.sweep);
        this.sweep = undefined;
    }

    /**
     * Moves the clock and drops what it just took past its expiry.
     *
     * <p>The filter in {@link statuses} is what makes the board honest; this prune is what stops
     * the maps growing without bound in a long-lived window. Only rewrites the signal when
     * something actually fell off, so an idle household costs one comparison per entry per
     * sweep.</p>
     */
    private tick(): void {
        const now = Date.now();
        this.nowMs.set(now);

        let changed = false;
        const next = new Map<string, ReadonlyMap<string, HomeStatusDto>>();
        for (const [guildId, map] of this._byGuild()) {
            const kept = new Map([...map].filter(([, s]) => Date.parse(s.expiresAt) > now));
            if (kept.size !== map.size) changed = true;
            next.set(guildId, kept);
        }
        if (changed) this._byGuild.set(next);
    }
}
