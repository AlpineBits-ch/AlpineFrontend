import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {AuthService} from './auth.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

export enum ConnectionState {
    Connected,
    Disconnected,
    Connecting,
}

/**
 * How long the server may hear nothing from us before it declares this client gone.
 *
 * SignalR's default is 30s, which assumes the ping that refreshes it is dependable. It is not: the
 * ping runs on a `setInterval` in the renderer, and once this window has been hidden for a few
 * minutes Chromium's intensive throttling aligns timer wake-ups to one-minute boundaries no matter
 * what delay was asked for. A 15s ping therefore arrives every 60s at best, past a 30s deadline,
 * and the hub drops a client whose media is still flowing. This codebase has written the same
 * hazard down twice already, in the only other two places that needed a clock -
 * `voice-activity.service.ts` ("a hidden tab does not get animation frames at all ... and 'hidden'
 * is the *normal* case for this feature, since the reason VAD exists at all is that the game, not
 * the tab, has focus") and `spatial-audio.service.ts` ("while the game is focused this window is
 * backgrounded, which pauses rAF entirely but only throttles timers"). Both accepted a coarser
 * clock because their output degrades gracefully. A timeout does not degrade: it is a deadline.
 *
 * 120s clears the ~60s throttled period with room for one wake-up to be missed entirely, which
 * page freezing can do. Paired with `ClientTimeoutInterval = 120s` on the hub; the two are one
 * setting split across two repositories and must be changed together.
 */
const SERVER_TIMEOUT_MS = 120_000;

/**
 * How often we ping the hub when there is nothing else to send.
 *
 * Set against the hub's own `ClientTimeoutInterval` (120s), not against {@link SERVER_TIMEOUT_MS} -
 * these are two independent settings in the JS client, and it is the *server's* deadline this ping
 * refreshes. 30s into 120s gives four chances to land inside the window, so three consecutive
 * throttled or frozen wake-ups still do not disconnect us. The library default is 15s against a 30s
 * timeout: two chances, which is exactly the margin that proved too thin.
 *
 * Note that a longer interval is not what buys the margin - a 15s ping and a 30s one both arrive
 * every ~60s once Chromium is throttling, so under the failure this fixes they behave identically.
 * The window does the work; 30s simply halves the idle chatter, which the hub tolerates because it
 * waits 120s. The hub's own `KeepAliveInterval` deliberately stays at 15s and is not mirrored here:
 * it is judged by clients we are not shipping - the mobile app among them - whose `serverTimeout` is
 * still the 30s default. See `RealtimeHubTimeouts` in Echo.
 */
const KEEP_ALIVE_INTERVAL_MS = 30_000;

/**
 * Owns the single SignalR connection for the whole app (`/api/v1/ws/hub`).
 *
 * Since the backend cutover to one connection per user, every feature that used
 * to have its own hub (messaging, voice/calls, guild) now shares this connection.
 * Event and method names are domain-prefixed (`conversation.*`, `presence.*`,
 * `call.*`, `guild.*`, `guild.voice.*`) so a single pipe can carry all of them.
 *
 * The connection is built on first {@link start} rather than in the constructor: the URL carries
 * a `deviceId` the server buckets per-device events by (`call.CallDeviceDismissed`,
 * `call.CallDeviceTakeover`, `guild.voice.KickedByOtherDevice`), and resolving it is async.
 * Handlers registered before then are queued and replayed, because every consuming service
 * relies on {@link on} being safe to call before {@link start}.
 */
@Injectable({providedIn: 'root'})
export class RealtimeConnectionService {
    public readonly connectionState = signal(ConnectionState.Disconnected);
    private hubConnection: signalR.HubConnection | null = null;
    private pendingHandlers: { event: string; handler: (...args: any[]) => void }[] = [];
    private readonly authService = inject(AuthService);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private starting?: Promise<void>;

    /** Register a server → client event handler. Safe to call before or after {@link start}. */
    on(event: string, handler: (...args: any[]) => void): void {
        if (this.hubConnection) {
            this.hubConnection.on(event, handler);
            return;
        }
        this.pendingHandlers.push({event, handler});
    }

    /** Remove all handlers for an event. */
    off(event: string): void {
        this.pendingHandlers = this.pendingHandlers.filter(h => h.event !== event);
        this.hubConnection?.off(event);
    }

    /**
     * Fire a client → server invocation. No-op when disconnected and never rejects
     * -errors are logged so callers can treat it as fire-and-forget.
     */
    async invoke(method: string, ...args: unknown[]): Promise<void> {
        if (!this.hubConnection) return;
        if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await this.hubConnection.invoke(method, ...args);
        } catch (err) {
            console.error(`Realtime invoke '${method}' failed:`, err);
        }
    }

    /** Idempotent: starts the connection once; concurrent callers share one attempt. */
    async start(): Promise<void> {
        if (this.hubConnection?.state === signalR.HubConnectionState.Connected) return;
        if (this.starting) return this.starting;

        this.starting = this.build()
            .then(connection => connection.start())
            .then(() => {
                this.connectionState.set(ConnectionState.Connected);
            })
            .catch(err => {
                console.error('Realtime: connection error', err);
                this.connectionState.set(ConnectionState.Disconnected);
            })
            .finally(() => {
                this.starting = undefined;
            });

        return this.starting;
    }

    private async build(): Promise<signalR.HubConnection> {
        if (this.hubConnection) return this.hubConnection;

        const connection = new signalR.HubConnectionBuilder()
            .withUrl(await this.hubUrl(), {
                accessTokenFactory: () => this.authService.ensureValidToken(),
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext =>
                    Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 60_000),
            })
            // Not the library defaults, deliberately: they are tuned for a foreground browser tab,
            // and this app's normal case is a desktop window sitting behind a game. See the two
            // constants for what the defaults cost - a hub drop that shortens the voice liveness
            // window and gets the participant swept, while Rust goes on publishing their screen
            // share to a room that has forgotten them.
            .withServerTimeout(SERVER_TIMEOUT_MS)
            .withKeepAliveInterval(KEEP_ALIVE_INTERVAL_MS)
            .build();

        this.hubConnection = connection;
        this.wireLifecycle(connection);

        for (const {event, handler} of this.pendingHandlers) connection.on(event, handler);
        this.pendingHandlers = [];

        return connection;
    }

    /**
     * A device id we cannot resolve degrades to no query parameter rather than failing the
     * connection. The hub applies no validation - it just falls back to the `default` bucket -
     * so a broken store costs per-device event routing, not the whole realtime layer.
     */
    private async hubUrl(): Promise<string> {
        const base = `${this.apiConfig.baseUrl()}/api/v1/ws/hub`;
        try {
            return `${base}?deviceId=${encodeURIComponent(await this.deviceIdentity.deviceId())}`;
        } catch (err) {
            console.error('Realtime: could not resolve device id, connecting without it', err);
            return base;
        }
    }

    private wireLifecycle(connection: signalR.HubConnection): void {
        // No notification here: automatic reconnects normally resolve within milliseconds, so a
        // toast for one is noise. `connectionState` still moves, for anything that needs to react.
        connection.onreconnecting(() => {
            this.connectionState.set(ConnectionState.Connecting);
        });

        connection.onreconnected(() => {
            this.connectionState.set(ConnectionState.Connected);
        });

        connection.onclose(() => {
            this.connectionState.set(ConnectionState.Disconnected);
        });
    }
}
