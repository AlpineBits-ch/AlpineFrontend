import {inject, Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * Signalling for Isle proximity voice over the shared SignalR hub.
 *
 * Mirrors {@link GuildWebsocketService}: it does NOT own a hub connection -it
 * registers `isle.*` handlers on the single {@link RealtimeConnectionService}
 * and re-broadcasts each event into an RxJS `Subject`. There are no client→server
 * invokes for proximity voice; positions originate from the game server, so the
 * whole flow is server-push + REST.
 *
 * All payloads are camelCase and peers are keyed by `userId`.
 */

/** Local player entered an Isle game server. `userId` is being added backend-side. */
export interface IslePlayerJoined {
    playerId: string;
    steamId: string;
    userId?: string;
}

/** Local player left the Isle game server. */
export interface IslePlayerDisconnected {
    playerId?: string;
    steamId?: string;
    userId?: string;
}

/** Pull this peer's audio: their remote track lives at (cfSessionId, trackName). */
export interface IsleSubscribeMutual {
    targetUserId: string;
    cfSessionId: string;
    trackName: string;
}

/**
 * The caller's own position + facing -the listener origin.
 *
 * Telemetry arrives at ~1 Hz; the velocity vector lets the client extrapolate
 * between samples so motion is smooth instead of a 1 s stutter.
 */
export interface IsleSelfPosition {
    x: number;
    y: number;
    z: number;
    /** Degrees, Unreal convention (0 = +X). May be 0 if the plugin omits rotation. */
    yaw: number;
    /** Velocity, UE units/second, same axes as position. Absent on old servers → treat as 0. */
    vx?: number;
    vy?: number;
    vz?: number;
    /** Server unix-ms sample time. Ordering/dedupe ONLY -not a wall clock (server↔client skew). */
    timestampMs?: number;
}

/** A peer in the caller's cell moved/turned. Velocity fields as per {@link IsleSelfPosition}. */
export interface IslePlayerPosition {
    userId: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    vx?: number;
    vy?: number;
    vz?: number;
    timestampMs?: number;
}

/** A single peer left the caller's earshot (walked out of the 3×3 block, or left voice). */
export interface IslePeerLeft {
    userId: string;
}

/**
 * The server no longer knows where our published track lives -re-publish it.
 *
 * Sent when Isle restarts and loses its in-memory publish registry. The hub
 * connection is terminated at the gateway rather than on Isle, so the socket
 * survives the restart and no reconnect (and therefore no re-publish) is
 * triggered client-side: we would keep hearing peers while nobody could pull
 * our audio. Payload-free -it is purely a nudge.
 *
 * Absent from the published realtime contract (`docs.venta.gg/asyncapi.json`)
 * but confirmed present server-side as `SfuSocketEvents.RepublishVoice`. The
 * contract is generated from call sites and does not reach Isle's SFU constants,
 * so its silence about an `isle.*` event is not evidence the event is dead -
 * check the Isle source before concluding anything is unused here.
 */

@Injectable({providedIn: 'root'})
export class IsleVoiceWebsocketService {
    public readonly playerJoined$ = new Subject<IslePlayerJoined>();
    public readonly playerDisconnected$ = new Subject<IslePlayerDisconnected>();
    public readonly subscribeMutual$ = new Subject<IsleSubscribeMutual>();
    public readonly selfPosition$ = new Subject<IsleSelfPosition>();
    public readonly playerPosition$ = new Subject<IslePlayerPosition>();
    public readonly peerLeft$ = new Subject<IslePeerLeft>();
    public readonly republishVoice$ = new Subject<void>();

    private realtime = inject(RealtimeConnectionService);
    private listenersSetUp = false;

    /** Shared connection state -one connection backs every realtime feature. */
    get connectionState() {
        return this.realtime.connectionState;
    }

    async start(): Promise<void> {
        if (!this.listenersSetUp) {
            this.listenersSetUp = true;
            this.setupListeners();
        }
        await this.realtime.start();
    }

    private setupListeners(): void {
        this.realtime.on('isle.PlayerJoined', (d: IslePlayerJoined) => this.playerJoined$.next(d));
        this.realtime.on('isle.PlayerDisconnected', (d: IslePlayerDisconnected) => this.playerDisconnected$.next(d));
        this.realtime.on('isle.SubscribeMutual', (d: IsleSubscribeMutual) => this.subscribeMutual$.next(d));
        this.realtime.on('isle.SelfPosition', (d: IsleSelfPosition) => this.selfPosition$.next(d));
        this.realtime.on('isle.PlayerPosition', (d: IslePlayerPosition) => this.playerPosition$.next(d));
        this.realtime.on('isle.PeerLeft', (d: IslePeerLeft) => this.peerLeft$.next(d));
        this.realtime.on('isle.RepublishVoice', () => this.republishVoice$.next());
    }
}
