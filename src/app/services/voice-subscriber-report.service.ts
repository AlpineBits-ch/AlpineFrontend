import {inject, Injectable, Injector, OnDestroy} from '@angular/core';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceService} from './voice.service';
import {scopeKey, WatchScope} from './share-watch.service';

/**
 * How long the tile sizes have to stop moving before they are reported, in milliseconds.
 *
 * <p>Sized to outlast the things that move tiles rather than to feel responsive: a CSS grid reflow
 * when somebody joins, the panel's own height transition, and a window drag, which fires
 * `ResizeObserver` at frame rate for as long as the mouse is down. The reply to this request costs
 * the server a re-plan and can move every viewer's subscription set, so a report per frame would be
 * a renegotiation storm for a window that ends up back where it started.</p>
 *
 * <p>The cost of waiting is that a viewer who just enlarged a tile spends a fraction of a second on
 * the layer they had, which is a soft picture that sharpens - the same thing every video product
 * does on a layer switch, and strictly better than the alternative of never switching at all.</p>
 */
export const TILE_REPORT_DEBOUNCE_MS = 500;

/**
 * How much a tile has to have moved, as a fraction of what was last reported, to be worth
 * re-reporting.
 *
 * <p>The server buckets heights into three layers at 180 and 360 device pixels, so anything smaller
 * than this is usually a report that changes nothing at all. It is deliberately a ratio rather than
 * those two thresholds: hard-coding the boundaries here would couple this client to a server option
 * that is meant to be tunable, and would silently stop reporting the moment it was tuned.</p>
 */
const MATERIAL_CHANGE_RATIO = 0.15;

/** One room's worth of measurements. */
interface RoomTiles {
    scope: WatchScope;
    /** Tile id (`camera:{userId}` / `share:{shareId}`) to its measurement. */
    tiles: Map<string, {userId: string; height: number}>;
    /** The `tileHeights` map as last sent, so an unchanged resize costs nothing. */
    sent: Map<string, number>;
    timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Reports how large this client actually draws each publisher, so the server can pick a simulcast
 * layer to match.
 *
 * <p><b>This is the only measurement the server has.</b> It chooses the layer each viewer is served
 * and puts that rid on the subscribe it makes to the SFU on their behalf, so a tile reported as 120
 * pixels tall is <i>served</i> the low layer whether or not this client's transport asked for one.
 * Without a report the server falls back to a deliberate guess - the middle layer for a camera in a
 * large room, full quality for a screen share - which is worse than the number this client is
 * holding in its layout engine. See `voice-frontend-guide.md` §6.4 and §6.7.</p>
 *
 * <p>Everything reportable here can only ever <i>reduce</i> what this client is sent, which is why
 * it needs no permission beyond being in the room. The endpoint also accepts `paused`, `pinned`,
 * `pausedPublishers` and `screenAudioShares`; none of those are wired up yet, and the shape above
 * carries them so that adding one is a caller change rather than a contract change.</p>
 *
 * <p><b>The reply is ignored.</b> It is this client's own subscription set, and Alpine does not
 * implement selective subscription (§6.3) - it still subscribes to everyone who is `Publishing`,
 * which stays correct for every room the server does not rank. Reporting tile sizes is additive and
 * useful on its own: it is what makes the layer the server picks match the pixels on screen.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceSubscriberReportService implements OnDestroy {
    /**
     * The two API services are resolved on use rather than injected.
     *
     * <p>This service is reached from `trackTileHeight`, which runs inside every stage tile - leaf
     * presentational components that are unit-tested on their own, with no HTTP and no auth. Holding
     * `GuildVoiceService` as a field would put `-> ApiConfigService -> OAuthService` on the injection
     * path of `app-call-share-tile`, so rendering a tile in a test would need the whole voice API
     * surface provided to draw a border. Nothing here touches either service until a report is
     * actually flushed, which those tests never reach.</p>
     */
    private readonly injector = inject(Injector);

    private readonly rooms = new Map<string, RoomTiles>();

    ngOnDestroy(): void {
        for (const room of this.rooms.values()) {
            if (room.timer !== null) clearTimeout(room.timer);
        }
        this.rooms.clear();
    }

    /**
     * Records one tile's rendered height, in device pixels.
     *
     * <p>Keyed by tile rather than by publisher, because one publisher can be on screen twice - a
     * camera seat and a screen share, in the same grid. The server's map is per publisher, so the
     * two are reconciled by taking the larger at flush time: the contract asks for "the largest tile
     * you draw them in", and being served a layer that is too good for the small tile is the right
     * way round to be wrong.</p>
     *
     * <p>Safe to call on every resize notification. Only a materially different measurement reaches
     * the network, and even that is debounced.</p>
     */
    report(scope: WatchScope, tileId: string, userId: string, height: number): void {
        if (height <= 0) return;
        const room = this.roomFor(scope);
        const rounded = Math.round(height);
        const previous = room.tiles.get(tileId);
        if (previous && previous.userId === userId && previous.height === rounded) return;

        room.tiles.set(tileId, {userId, height: rounded});
        this.schedule(room);
    }

    /** A tile left the layout - it was scrolled out, collapsed, maximised away, or destroyed. */
    release(scope: WatchScope, tileId: string): void {
        const room = this.rooms.get(scopeKey(scope));
        if (!room || !room.tiles.delete(tileId)) return;
        this.schedule(room);
    }

    /**
     * Drops everything for a room - the channel was left, or the call ended.
     *
     * <p>Nothing is sent on the way out. The server prunes tile heights for publishers who are no
     * longer present on its own (`VoiceAttention`), and a client that has left the room would be
     * reporting on a room it is not in.</p>
     */
    clear(scope: WatchScope): void {
        const key = scopeKey(scope);
        const room = this.rooms.get(key);
        if (!room) return;
        if (room.timer !== null) clearTimeout(room.timer);
        this.rooms.delete(key);
    }

    private roomFor(scope: WatchScope): RoomTiles {
        const key = scopeKey(scope);
        let room = this.rooms.get(key);
        if (!room) {
            room = {scope, tiles: new Map(), sent: new Map(), timer: null};
            this.rooms.set(key, room);
        }
        // The scope object is rebuilt on every change detection pass by the callers' `computed`s;
        // the key is what identifies the room, so the newest object simply replaces the held one.
        room.scope = scope;
        return room;
    }

    /**
     * Arm the trailing debounce, unless what is held would send exactly what was already sent.
     *
     * <p>The materiality check is done here rather than at flush time so that a stream of
     * insignificant resizes never arms the timer at all - a window drag that ends a few pixels from
     * where it started makes no request instead of one.</p>
     */
    private schedule(room: RoomTiles): void {
        if (room.timer !== null) return;
        if (!this.hasMaterialChange(room)) return;
        room.timer = setTimeout(() => {
            room.timer = null;
            this.flush(room);
        }, TILE_REPORT_DEBOUNCE_MS);
    }

    private hasMaterialChange(room: RoomTiles): boolean {
        const next = this.heightsOf(room);
        if (next.size !== room.sent.size) return true;

        for (const [userId, height] of next) {
            const before = room.sent.get(userId);
            if (before === undefined) return true;
            if (Math.abs(height - before) / Math.max(before, 1) >= MATERIAL_CHANGE_RATIO) return true;
        }
        return false;
    }

    /** Publisher to their largest tile - see {@link report}. */
    private heightsOf(room: RoomTiles): Map<string, number> {
        const heights = new Map<string, number>();
        for (const {userId, height} of room.tiles.values()) {
            heights.set(userId, Math.max(heights.get(userId) ?? 0, height));
        }
        return heights;
    }

    /**
     * Send the complete map, always.
     *
     * <p>The server <b>replaces</b> `tileHeights` wholesale rather than merging it, so a partial
     * body would silently drop the publishers it left out - which reads to the planner as "no
     * measurement" and puts them back on the guessed layer. Sending everything is also what makes
     * {@link release} work without a delete verb.</p>
     */
    private flush(room: RoomTiles): void {
        const heights = this.heightsOf(room);
        const tileHeights: Record<string, number> = {};
        for (const [userId, height] of heights) tileHeights[userId] = height;

        const {scope} = room;
        const request =
            scope.kind === 'channel'
                ? this.injector
                      .get(GuildVoiceService)
                      .updateSubscriber(scope.guildId, scope.channelId, {tileHeights})
                : this.injector.get(VoiceService).updateSubscriber(scope.callId, {tileHeights});

        // Recorded before the response, so a request in flight cannot be re-sent by a resize that
        // lands while it is out. A failure below rolls it back rather than leaving us convinced we
        // reported something we did not.
        room.sent = heights;

        request.subscribe({
            next: () => void 0,
            error: () => {
                // Silent, and deliberately so: this is a cost optimisation, not a call function.
                // Refused (not in the room yet), offline, or a server that predates the endpoint -
                // in every case the room keeps working exactly as it did before tile reporting
                // existed, at full quality. Forgetting what was sent is what makes the next resize
                // retry rather than dedupe against a report that never landed.
                room.sent = new Map();
            },
        });
    }
}
