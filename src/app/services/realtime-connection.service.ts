import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {AuthService} from './auth.service';
import {NotificationService, NotificationSound} from './notification.service';
import {ApiConfigService} from './api-config.service';

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
 * Feature services register their handlers via {@link on} and send via
 * {@link invoke}; they keep their own public observables so consumers are
 * unaffected by the consolidation.
 */
@Injectable({providedIn: 'root'})
export class RealtimeConnectionService {
    public readonly connectionState = signal(ConnectionState.Disconnected);
    private readonly hubConnection: signalR.HubConnection;
    private readonly authService = inject(AuthService);
    private readonly notificationService = inject(NotificationService);
    private readonly apiConfig = inject(ApiConfigService);
    private starting?: Promise<void>;
    private reconnectNotified = false;

    constructor() {
        this.hubConnection = new signalR.HubConnectionBuilder()
            .withUrl(this.apiConfig.baseUrl() + '/api/v1/ws/hub', {
                accessTokenFactory: () => this.authService.ensureValidToken(),
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext =>
                    Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 60_000),
            })
            .build();

        this.wireLifecycle();
    }

    /** Register a server → client event handler. Safe to call before or after {@link start}. */
    on(event: string, handler: (...args: any[]) => void): void {
        this.hubConnection.on(event, handler);
    }

    /** Remove all handlers for an event. */
    off(event: string): void {
        this.hubConnection.off(event);
    }

    /**
     * Fire a client → server invocation. No-op when disconnected and never rejects
     * -errors are logged so callers can treat it as fire-and-forget.
     */
    async invoke(method: string, ...args: unknown[]): Promise<void> {
        if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await this.hubConnection.invoke(method, ...args);
        } catch (err) {
            console.error(`Realtime invoke '${method}' failed:`, err);
        }
    }

    /** Idempotent: starts the connection once; concurrent callers share one attempt. */
    async start(): Promise<void> {
        if (this.hubConnection.state === signalR.HubConnectionState.Connected) return;
        if (this.starting) return this.starting;

        this.starting = this.hubConnection.start()
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

    private wireLifecycle(): void {
        this.hubConnection.onreconnecting(() => {
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

        this.hubConnection.onreconnected(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Connected);
        });

        this.hubConnection.onclose(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Disconnected);
        });
    }
}
