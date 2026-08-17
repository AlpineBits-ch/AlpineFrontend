import {inject, Injectable, OnDestroy, signal} from '@angular/core';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceService} from './voice.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';

/** Where a screen share lives. Guild voice and direct calls draw share ids from different spaces. */
export type WatchScope =
    | {kind: 'channel'; guildId: string; channelId: string}
    | {kind: 'call'; callId: string};

export function scopeKey(scope: WatchScope): string {
    return scope.kind === 'channel' ? `channel:${scope.channelId}` : `call:${scope.callId}`;
}

/**
 * How often a watch claim is re-announced. The server expires one after 90s, so this has to be
 * comfortably under that - a claim that lapses because a heartbeat was a little late shows the
 * streamer their audience draining while everyone is still watching.
 */
const HEARTBEAT_MS = 45_000;

/**
 * Announces which screen shares this client is actually watching, and tracks who else is.
 *
 * <p>The server cannot work this out on its own. Media is pulled from Cloudflare by the client, and
 * a pull has no teardown a client is obliged to send: a viewer who closes the app, loses the
 * network, or simply hides the stream sends nothing at all. So watching is stated explicitly and
 * expires on its own, which makes a stale count a matter of seconds rather than forever.</p>
 *
 * <p>Claims are driven by what is on screen rather than by what is subscribed. Maximising one share
 * stops the others being rendered, and their streamers should stop counting this client - which is
 * the honest answer, and the one a subscribe-based signal could never give.</p>
 */
@Injectable({providedIn: 'root'})
export class ShareWatchService implements OnDestroy {
    private guildVoice = inject(GuildVoiceService);
    private voiceService = inject(VoiceService);
    private guildWs = inject(GuildWebsocketService);
    private voiceWs = inject(VoiceWebsocketService);

    /** scopeKey -> shareId -> the user ids watching it, as last reported by the server. */
    private readonly viewers = signal<Record<string, Record<string, string[]>>>({});

    /** scopeKey -> the shares this client is currently claiming, with the scope to renew them on. */
    private readonly claims = new Map<string, {scope: WatchScope; shareIds: Set<string>}>();

    private heartbeat: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.guildWs.shareViewersChangedObservable.subscribe(dto => this.applyViewers(dto));
        this.voiceWs.shareViewersChangedObservable.subscribe(dto => this.applyViewers(dto));
    }

    ngOnDestroy(): void {
        this.stopHeartbeat();
    }

    /** How many people are watching a share, this client included. */
    viewerCount(scope: WatchScope, shareId: string): number {
        return this.viewersOf(scope, shareId).length;
    }

    viewersOf(scope: WatchScope, shareId: string): string[] {
        return this.viewers()[scopeKey(scope)]?.[shareId] ?? [];
    }

    /**
     * Declares the complete set of shares on screen for this scope.
     *
     * <p>Idempotent, and safe to call on every render: only the difference from the previous call
     * reaches the network.</p>
     */
    setWatching(scope: WatchScope, shareIds: readonly string[]): void {
        const key = scopeKey(scope);
        const next = new Set(shareIds);
        const current = this.claims.get(key)?.shareIds ?? new Set<string>();

        for (const shareId of next) {
            if (!current.has(shareId)) this.watch(scope, shareId);
        }
        for (const shareId of current) {
            if (!next.has(shareId)) this.unwatch(scope, shareId);
        }

        if (next.size === 0) this.claims.delete(key);
        else this.claims.set(key, {scope, shareIds: next});

        if (this.claims.size > 0) this.startHeartbeat();
        else this.stopHeartbeat();
    }

    /** Drops every claim in a scope - the channel was left, or the call ended. */
    clear(scope: WatchScope): void {
        this.setWatching(scope, []);
        this.viewers.update(state => {
            const key = scopeKey(scope);
            if (!(key in state)) return state;
            const next = {...state};
            delete next[key];
            return next;
        });
    }

    /**
     * Reads who is watching what, for a client that arrived after the fact. The change events are
     * only ever deltas, so joining a channel where a stream is already being watched otherwise
     * shows an audience of nobody until the next viewer comes or goes.
     */
    refresh(scope: WatchScope): void {
        const request = scope.kind === 'channel'
            ? this.guildVoice.getShareViewers(scope.guildId, scope.channelId)
            : this.voiceService.getShareViewers(scope.callId);

        request.subscribe({
            next: snapshot => this.viewers.update(state => ({...state, [scopeKey(scope)]: snapshot})),
            // Silent: a missing count is cosmetic, and the next change event fills it in.
            error: () => void 0,
        });
    }

    private watch(scope: WatchScope, shareId: string): void {
        const request = scope.kind === 'channel'
            ? this.guildVoice.watchShare(scope.guildId, scope.channelId, shareId)
            : this.voiceService.watchShare(scope.callId, shareId);

        request.subscribe({
            next: dto => this.applyViewers(dto),
            // Refused (not in the channel yet, share already gone) or offline. The claim stays in
            // the local set so the next heartbeat retries; nothing here is worth interrupting a
            // call for.
            error: () => void 0,
        });
    }

    private unwatch(scope: WatchScope, shareId: string): void {
        const request = scope.kind === 'channel'
            ? this.guildVoice.unwatchShare(scope.guildId, scope.channelId, shareId)
            : this.voiceService.unwatchShare(scope.callId, shareId);

        request.subscribe({next: dto => this.applyViewers(dto), error: () => void 0});
    }

    /**
     * Applies a viewer list from either the watch response or the broadcast.
     *
     * <p>The two carry the same shape and are equally authoritative - the response is simply the
     * broadcast this client caused, arriving by the shorter route.</p>
     */
    private applyViewers(dto: ShareViewersDto): void {
        const key = dto.channelId ? `channel:${dto.channelId}` : dto.callId ? `call:${dto.callId}` : null;
        if (!key) return;

        this.viewers.update(state => ({
            ...state,
            [key]: {...state[key], [dto.shareId]: dto.viewerIds},
        }));
    }

    private startHeartbeat(): void {
        if (this.heartbeat !== null) return;
        this.heartbeat = setInterval(() => this.renewAll(), HEARTBEAT_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeat === null) return;
        clearInterval(this.heartbeat);
        this.heartbeat = null;
    }

    /** Re-posting a claim is how it stays alive; the server treats a repeat as a refresh. */
    private renewAll(): void {
        for (const {scope, shareIds} of this.claims.values()) {
            for (const shareId of shareIds) this.watch(scope, shareId);
        }
    }
}
