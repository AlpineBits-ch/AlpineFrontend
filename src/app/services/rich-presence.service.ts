import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {catchError, of} from 'rxjs';
import {Presence} from '../platform/ports/presence.port';
import {WindowChrome} from '../platform/ports/window-chrome.port';
import {Activity, activitiesEqual, MAX_ACTIVITIES} from '../models/activity.model';
import {ApiConfigService} from './api-config.service';
import {GameCatalogService} from './game-catalog.service';
import {PlatformService} from './platform.service';
import {PrivacySettingsService} from './privacy-settings.service';
import {UserSettingsService} from './user-settings.service';

/**
 * Discord's own RPC write limit, and the one the server rate-limits us to. Every outbound write is
 * coalesced into a window this wide — see {@link RichPresenceService.schedulePush}.
 */
const PUSH_INTERVAL_MS = 15_000;

/**
 * The legacy fallback poll.
 *
 * <p>Deliberately slow, and deliberately <b>not</b> a second source of truth. The Rust arbiter is
 * the single writer: it merges process detection, RPC and media by priority and emits
 * `presence://changed` only on real change, and `rich_presence.rs` already feeds
 * `scan_game_process` into it. So once one event has arrived, this poll must stay silent — see
 * {@link RichPresenceService.scan}. It exists only for a build with no presence module at all.</p>
 */
const FALLBACK_POLL_MS = 30_000;

/**
 * The local Discord-compatible RPC server's state, as `presence_rpc_status` reports it.
 *
 * <p>Mirrors the Rust `Status` (serde `camelCase`). Kept here rather than in `activity.model.ts`
 * because it is a desktop-integration detail, not part of the wire contract shared with the
 * server.</p>
 */
/**
 * The body of `PUT /profiles/me/activity` — what the server actually published.
 *
 * <p>The reason it is not a 204: an RPC payload carries an application id and no name, so the
 * client does not know what it just told everyone it was doing. See {@link
 * RichPresenceService.adoptPublishedNames}.</p>
 */
export interface SetActivityResult {
    activities: Activity[];
}

export interface PresenceRpcStatus {
    running: boolean;
    mode: 'proxy' | 'exclusive';
    /** The socket we bound, for diagnostics. */
    endpoint?: string | null;
    /**
     * Which `discord-ipc-N` we won.
     *
     * <p><b>Anything other than 0 means no game will find us this session.</b> Client libraries scan
     * 0..9 and stop at the first socket that accepts a handshake, so a non-zero index says Discord
     * (or something else) got there first. The setting is on and working and will still show
     * nothing — which is exactly the state a user would otherwise report as "it doesn't work".</p>
     */
    index?: number | null;
    connections: number;
    maxConnections: number;
}

/**
 * Detects what this machine is doing and publishes it.
 *
 * <p><b>Desktop-only, by platform, not by policy.</b> iOS and Android cannot enumerate processes or
 * bind the sockets any of this needs, so mobile and web clients render other people's activity and
 * never produce their own. The `Presence.supported` / `!isMobile` guard is load-bearing, not
 * defensive - it was `isTauri()` before the port layer, and it is still two questions rather than one
 * because `Presence.supported` is true on a Tauri phone build, which still cannot detect anything.</p>
 *
 * <p><b>What changed from the poll it replaces.</b> The old service called `scan_game_process` on a
 * 15 s interval and put the answer in a signal that one `console.log` read. It now subscribes to
 * `presence://changed`, which the Rust arbiter emits only when the merged result actually changes,
 * and it sends the result to the server. The poll survives as a fallback only.</p>
 */
@Injectable({providedIn: 'root'})
export class RichPresenceService {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly platform = inject(PlatformService);
    private readonly presence = inject(Presence);
    /** Only for the close hook: clearing the presence has to happen before the webview is torn down. */
    private readonly windowChrome = inject(WindowChrome);
    private readonly privacy = inject(PrivacySettingsService);
    private readonly userSettings = inject(UserSettingsService);
    private readonly catalog = inject(GameCatalogService);

    /**
     * What this machine has detected, before the per-game opt-outs are applied. Public so the
     * settings page can list the games it has actually seen rather than an empty box.
     */
    private readonly _detected = signal<Activity[]>([]);
    readonly detected = this._detected.asReadonly();

    /**
     * What we are willing to publish: everything detected, minus anything the user has hidden, and
     * nothing at all when `shareActivity` is off.
     *
     * <p>The `shareActivity` check is duplicated server-side, and the server's copy is the one that
     * matters. This one exists so that turning the setting off stops the data leaving the machine
     * rather than merely stopping it being forwarded — the strictly better failure mode, and the
     * only one that also covers the window before a projection change takes effect.</p>
     */
    private readonly publishable = computed<Activity[]>(() => {
        if (!this.privacy.settings().shareActivity) return [];
        const hidden = new Set(this.userSettings.activitySettings().hiddenGames);
        return this._detected()
            .filter(activity => !hidden.has(activity.name))
            .slice(0, MAX_ACTIVITIES);
    });

    /**
     * The last list the server was told about, so an unchanged detection is not re-sent. `null`
     * means "nothing has been sent yet", which is distinct from "an empty list has been sent" —
     * the latter is how a stopped game is communicated and must actually go out.
     */
    private lastPushed: Activity[] | null = null;
    private pushTimer?: ReturnType<typeof setTimeout>;
    private lastPushAt = 0;

    /**
     * `applicationId` → the name the server published for it.
     *
     * <p>Grows as applications are seen and never shrinks within a session: an id resolves to the
     * same name every time, so re-learning it costs nothing and forgetting it would put the
     * placeholder back the next time the same game started.</p>
     */
    private readonly canonicalNames = new Map<string, string>();

    private unlistenPresence?: () => void;
    private unlistenClose?: () => void;
    private pollInterval?: ReturnType<typeof setInterval>;
    private started = false;

    /**
     * Whether `presence://changed` has ever been delivered.
     *
     * <p>The switch between "the arbiter owns detection" and "there is no arbiter". One event is
     * proof the Rust module exists and is emitting, and from that moment the poll is redundant at
     * best and destructive at worst - it reports a bare `ProcessScan` sighting with no `details` or
     * `state`, which is a different activity by {@link activitiesEqual}, so it would overwrite a
     * rich RPC activity for the same game every 30 s and the presence would visibly flap.</p>
     *
     * <p>Keyed on "an event has arrived" rather than on `presence_rpc_status().running` on purpose:
     * this also covers `Native` and `Media` sources once they have producers, where an
     * RPC-specific check would need revisiting each time one is added.</p>
     */
    private eventSeen = false;

    /** Last value handed to the Rust RPC server, so the same one is not applied twice. */
    private rpcApplied: boolean | null = null;

    private readonly _rpcStatus = signal<PresenceRpcStatus | null>(null);
    /** What the local RPC server is doing, for the settings page. Null when it has never started. */
    readonly rpcStatus = this._rpcStatus.asReadonly();

    constructor() {
        // Covers every way the publishable set can change without a new detection: the privacy
        // toggle flipping, a per-game switch, or sign-out emptying the settings. Reading the
        // computed is the subscription; `schedulePush` does the coalescing.
        effect(() => {
            const activities = this.publishable();
            if (!this.started) return;
            this.schedulePush(activities);
        });

        // Binding `discord-ipc-0` follows the stored setting, not a button press. Doing it in an
        // effect is what makes "apply on launch" and "apply on toggle" the same code path: the
        // settings blob is fetched asynchronously, so this fires again when it lands, and again on
        // an account switch that brings a different answer. `start()` applies it too, for the
        // ordering where settings arrived before the service was started.
        effect(() => {
            const enabled = this.userSettings.activitySettings().discordIntegration;
            if (!this.started) return;
            void this.applyRpcMode(enabled);
        });
    }

    start(): void {
        if (this.started || !this.presence.supported || this.platform.isMobile) return;
        this.started = true;

        void this.subscribe();
        // Fire-and-forget: the Rust matcher already runs off whatever catalog was cached on a
        // previous start, and a client that has never reached the server stays on the legacy list
        // rather than waiting for one. Nothing below is sequenced behind it.
        void this.catalog.sync();
        void this.scan();
        this.pollInterval = setInterval(() => void this.scan(), FALLBACK_POLL_MS);
        void this.applyRpcMode(this.userSettings.activitySettings().discordIntegration);
    }

    /**
     * Stops detecting and tells the server we are done.
     *
     * <p>The clear is sent immediately rather than through {@link schedulePush}: this runs on
     * sign-out and on window close, and a coalesced write scheduled up to 15 s out would never
     * happen. The 300 s Redis TTL would eventually cover it, but "eventually" there means five
     * minutes of showing a game to everyone in every shared server after quitting.</p>
     */
    stop(): void {
        if (!this.started) return;
        this.started = false;

        clearInterval(this.pollInterval);
        this.pollInterval = undefined;
        clearTimeout(this.pushTimer);
        this.pushTimer = undefined;

        this.unlistenPresence?.();
        this.unlistenPresence = undefined;
        this.unlistenClose?.();
        this.unlistenClose = undefined;

        // Hands `discord-ipc-0` back. Holding a machine-wide socket for a signed-out client would
        // keep the real Discord's own rich presence broken for as long as Venta stayed open.
        // `rpcApplied` is reset first so the stop is actually issued and a later `start()` reapplies.
        this.rpcApplied = null;
        void this.applyRpcMode(false);

        // The next session re-decides from scratch whether an arbiter exists.
        this.eventSeen = false;

        this._detected.set([]);
        if (this.lastPushed !== null && this.lastPushed.length > 0) this.push([]);
        this.lastPushed = null;
    }

    /**
     * Wires the event channel, and degrades quietly when it is not there.
     *
     * <p>`presence://changed` is emitted by a Rust module that does not exist yet. `Presence.onChanged`
     * resolves regardless — registering for an event nobody emits is not an error — so the failure
     * mode is simply that the fallback poll is the only source. That is the intended behaviour for
     * every build until the Rust side lands, not a degraded state worth warning about.</p>
     */
    private async subscribe(): Promise<void> {
        try {
            this.unlistenPresence = await this.presence.onChanged(activities => {
                // Retires the fallback poll permanently. The first event proves the arbiter is
                // live, and from here it is the only thing allowed to write.
                this.eventSeen = true;
                clearInterval(this.pollInterval);
                this.pollInterval = undefined;

                this.setLocal(activities);
            });
        } catch (err) {
            console.warn('[RichPresence] presence://changed unavailable, falling back to polling', err);
        }

        // Prime from the arbiter's current state, because the event fires *only on change* and a
        // subscriber that arrives mid-game would otherwise see nothing until the game ends. That
        // matters more than it sounds: this runs on every sign-in and every webview reload, and the
        // poll standing in for it reports a name with no `applicationId`, which the server drops
        // outright. A non-empty answer also proves the arbiter is live, so it retires the poll on
        // exactly the same terms an event does.
        try {
            const current = await this.presence.current();
            if (current.length > 0 && this.started) {
                this.eventSeen = true;
                clearInterval(this.pollInterval);
                this.pollInterval = undefined;
                this.setLocal(current);
            }
        } catch {
            // No presence module in this build. The poll is already the fallback; nothing to say.
        }

        try {
            // Closing the window tears the webview down before an ordinary teardown would run, so
            // the clear has to be hung off the close request itself.
            //
            // <b>This listener owns the window's close.</b> Tauri calls `api.prevent_close()` for
            // any window that has a JS `tauri://close-requested` listener and then relies on the
            // JS wrapper to call `destroy()` once the handler resolves - so the moment this is
            // registered, the titlebar's close button goes through here. A throw out of the
            // handler skips the `destroy()` and the window silently refuses to close, which is
            // why this can never be allowed to reject: clearing a presence is not worth a window
            // the user cannot shut. The try/catch below is belt to the adapter's braces - the
            // `WindowChrome` Tauri adapter wraps every handler for exactly this reason.
            this.unlistenClose = await this.windowChrome.onCloseRequested(() => {
                try {
                    this.stop();
                } catch (err) {
                    console.warn('[RichPresence] teardown on window close failed', err);
                }
            });
        } catch (err) {
            console.warn('[RichPresence] could not hook window close', err);
        }
    }

    /**
     * The legacy path: the old single-game Tauri command, for a build with no presence module.
     *
     * <p><b>It writes only while the arbiter has never spoken.</b> `scan_game_process` now feeds the
     * arbiter on the Rust side, so calling it from here and writing the answer straight into
     * {@link setLocal} would bypass the very thing that merges the sources — and since a bare
     * `ProcessScan` sighting carries no `details` or `state`, it would replace a rich RPC activity
     * for the same game on every tick.</p>
     *
     * <p>The guard is re-checked after the await as well as before it: a scan already in flight when
     * the first event lands must not land on top of it. A cold start where both race is
     * self-correcting either way — the event is the last writer and the state it leaves is
     * right.</p>
     */
    private async scan(): Promise<void> {
        if (this.eventSeen) return;

        try {
            const game = await this.presence.scan();
            if (this.eventSeen || !this.started) return;

            if (!game) {
                this.setLocal([]);
                return;
            }

            // `scan_game_process` returns a bare title and nothing else - no start time, no details,
            // no application id. `startedAt` is stamped locally at first sighting and then held, so
            // that polling every 30 s does not restamp it and pin the elapsed timer at zero. The
            // server applies the same stickiness authoritatively; this only avoids fighting it.
            const existing = this._detected().find(a => a.name === game);
            this.setLocal([{
                type: 'Playing',
                name: game,
                source: 'ProcessScan',
                startedAt: existing?.startedAt ?? Date.now(),
            }]);
        } catch (err) {
            console.warn('[RichPresence] scan_game_process failed', err);
        }
    }

    /**
     * Starts or stops the local Discord-compatible RPC server to match the stored setting.
     *
     * <p>`presence::init` installs the arbiter but binds nothing: taking `discord-ipc-0` away from
     * the real Discord is the user's decision, which is why the toggle defaults to off and why this
     * is the only thing that ever starts the server. Proxy mode is requested explicitly — it relays
     * to the downstream Discord so both clients see the presence — though the Rust side also
     * defaults to it for any unrecognised value.</p>
     */
    private async applyRpcMode(enabled: boolean): Promise<void> {
        if (!this.presence.supported || this.platform.isMobile) return;
        if (this.rpcApplied === enabled) return;
        this.rpcApplied = enabled;

        try {
            const status = enabled
                ? await this.presence.rpcStart('proxy')
                : await this.presence.rpcStop();

            this._rpcStatus.set(status);

            if (enabled && status.running && status.index !== 0) {
                console.warn(
                    `[RichPresence] bound discord-ipc-${status.index}, not 0 - games stop at the ` +
                    'first socket that answers, so nothing will reach us until we hold 0.',
                );
            }
        } catch (err) {
            // Cleared rather than left set, so the next toggle (or the next launch) retries instead
            // of believing a state the Rust side never reached.
            this.rpcApplied = null;
            this._rpcStatus.set(null);
            console.warn('[RichPresence] could not apply Discord RPC integration', err);
        }
    }

    /** Records a detection, ignoring one that says nothing new. */
    private setLocal(activities: Activity[]): void {
        const named = this.applyCanonicalNames(activities);
        if (activitiesEqual(this._detected(), named)) return;
        this._detected.set(named.slice(0, MAX_ACTIVITIES));
    }

    /**
     * Replaces locally-invented names with the ones the server published.
     *
     * <p><b>Why the local name is a placeholder in the first place.</b> A `SET_ACTIVITY` payload
     * carries an application id and no name — Discord's protocol resolves the name centrally from
     * the application, so a game or an integration never sends one. The arbiter therefore has
     * nothing better than "Game" to show, and the server, which can resolve the id, is the only
     * party that knows the answer. Without this the user reads "Game" on their own profile while
     * everyone else in every shared server correctly reads "Volanta".</p>
     *
     * <p>Keyed on `applicationId` only, so a name is never invented for an activity the server did
     * not vouch for.</p>
     */
    private applyCanonicalNames(activities: Activity[]): Activity[] {
        if (this.canonicalNames.size === 0) return activities;

        return activities.map(activity => {
            const canonical = activity.applicationId
                ? this.canonicalNames.get(activity.applicationId)
                : undefined;

            return canonical && canonical !== activity.name ? {...activity, name: canonical} : activity;
        });
    }

    /**
     * Coalesces outbound writes to at most one per {@link PUSH_INTERVAL_MS}.
     *
     * <p>Leading-edge: the first change in a quiet period goes out immediately, because the whole
     * point is that launching a game shows up at once. Anything arriving inside the window is held
     * and the <i>latest</i> state is sent when it closes — so a burst of RPC updates from a game
     * that reports every few seconds costs one request, carrying the newest truth rather than the
     * oldest.</p>
     */
    private schedulePush(activities: Activity[]): void {
        if (this.lastPushed !== null && activitiesEqual(this.lastPushed, activities)) return;

        const elapsed = Date.now() - this.lastPushAt;
        if (elapsed >= PUSH_INTERVAL_MS) {
            this.push(activities);
            return;
        }

        // A timer is already pending; it will read `publishable()` fresh when it fires, so there is
        // nothing to reschedule and re-arming it would push the write further out on every change.
        if (this.pushTimer) return;

        this.pushTimer = setTimeout(() => {
            this.pushTimer = undefined;
            if (this.started) this.push(this.publishable());
        }, PUSH_INTERVAL_MS - elapsed);
    }

    /**
     * `PUT /api/v1/social/profiles/me/activity`.
     *
     * <p>The `social` segment is the public path: the gateway rewrites `/api/v1/social/**` to
     * `/api/v1/**` before it reaches the service, so the service-internal route is one segment
     * shorter. Built off {@link ApiConfigService.baseUrl} like every neighbour in
     * {@link ProfileService} so that a self-hosted server is reached too.</p>
     */
    private push(activities: Activity[]): void {
        this.lastPushed = activities;
        this.lastPushAt = Date.now();

        this.http
            .put<SetActivityResult>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/me/activity`, {activities})
            .pipe(catchError(err => {
                // Cleared so the next change retries rather than being deduplicated against a state
                // the server never accepted.
                this.lastPushed = null;
                console.warn('[RichPresence] could not publish activity', err);
                return of(null);
            }))
            .subscribe(result => this.adoptPublishedNames(result));
    }

    /**
     * Takes the names the server actually published.
     *
     * <p>The response is what went out to everyone else, so it is authoritative by definition — and
     * it is the only place a name resolved from an application id ever appears on this side.</p>
     *
     * <p>{@link lastPushed} is updated to the server's own list rather than left as what we sent.
     * That is what stops the correction from looking like a change and bouncing straight back out:
     * the rename lands in {@link _detected}, `publishable()` recomputes, and the dedup in
     * {@link schedulePush} then finds it already sent. Safe because {@link activitiesEqual} compares
     * exactly the fields both sides agree on.</p>
     */
    private adoptPublishedNames(result: SetActivityResult | null): void {
        if (!result?.activities?.length) return;

        let learned = false;
        for (const activity of result.activities) {
            if (!activity.applicationId || !activity.name) continue;
            if (this.canonicalNames.get(activity.applicationId) === activity.name) continue;

            this.canonicalNames.set(activity.applicationId, activity.name);
            learned = true;
        }

        if (!learned || !this.started) return;

        const renamed = this.applyCanonicalNames(this._detected());
        if (activitiesEqual(this._detected(), renamed)) return;

        this._detected.set(renamed);
        this.lastPushed = this.applyCanonicalNames(this.lastPushed ?? []);
    }
}
