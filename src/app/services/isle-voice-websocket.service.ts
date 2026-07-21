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

/** The caller's own position + facing -the listener origin. */
export interface IsleSelfPosition {
    x: number;
    y: number;
    z: number;
    /** Degrees, Unreal convention (0 = +X). May be 0 if the plugin omits rotation. */
    yaw: number;
}

/** A peer in the caller's cell moved/turned. */
export interface IslePlayerPosition {
    userId: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
}

/** A single peer left the caller's earshot (walked out of the 3×3 block, or left voice). */
export interface IslePeerLeft {
    userId: string;
}

@Injectable({providedIn: 'root'})
export class IsleVoiceWebsocketService {
    public readonly playerJoined$ = new Subject<IslePlayerJoined>();
    public readonly playerDisconnected$ = new Subject<IslePlayerDisconnected>();
    public readonly subscribeMutual$ = new Subject<IsleSubscribeMutual>();
    public readonly selfPosition$ = new Subject<IsleSelfPosition>();
    public readonly playerPosition$ = new Subject<IslePlayerPosition>();
    public readonly peerLeft$ = new Subject<IslePeerLeft>();

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
    }
}
