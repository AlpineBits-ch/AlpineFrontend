import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {AuthService} from './auth.service';
import {NotificationService, NotificationSound} from './notification.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

export enum ConnectionState {
    Connected,
    Disconnected,
    Connecting,
}

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
    private readonly notificationService = inject(NotificationService);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private starting?: Promise<void>;
    private reconnectNotified = false;

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
        connection.onreconnecting(() => {
            if (!this.reconnectNotified) {
                this.reconnectNotified = true;
                this.notificationService.createNotification({
                    title: 'Reconnecting',
                    message: 'Attempting to reconnect...',
                    sound: NotificationSound.NewMessage,
                }).catch(() => {
                });
            }
            this.connectionState.set(ConnectionState.Connecting);
        });

        connection.onreconnected(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Connected);
        });

        connection.onclose(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Disconnected);
        });
    }
}
