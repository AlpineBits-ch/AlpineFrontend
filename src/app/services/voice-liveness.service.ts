import {inject, Injectable, OnDestroy} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, Subject} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceService} from './voice.service';
import {scopeKey, WatchScope} from './share-watch.service';

/**
 * How often this client asserts, over HTTP, that it is still in the room.
 *
 * <p>The server evicts a participant it has not heard from for 90s, so this is a third of the
 * window: two consecutive assertions can be lost - a request that never leaves, a gateway restart,
 * a laptop lid - and the third still lands before the sweep. Matching the sweep more closely would
 * make every single dropped request a coin flip on the call.</p>
 *
 * <p>Same 30s as the Flutter client, deliberately: both clients answer to the same sweep, and a
 * cadence that differs per client makes an eviction report impossible to reason about.</p>
 */
export const VOICE_ALIVE_INTERVAL_MS = 30_000;

/** One room being kept alive. */
interface LiveRoom {
    scope: WatchScope;
    timer: ReturnType<typeof setInterval>;
}

/**
 * Keeps this device's seat in a voice room alive over HTTP, independently of SignalR.
 *
 * <p><b>Why this exists at all.</b> `voice.Heartbeat` was our only liveness channel, and it rides
 * the hub connection - the one thing whose failure it would have to report. A hub outage that
 * outlasts the 90s eviction sweep therefore takes voice down with it, with the media transport
 * still connected and audio still flowing: the peers simply stop being told we are there. That is
 * the failure class behind the backgrounded-client evictions, where the hub ping was the first
 * domino. This service is the second, independent channel, and it is why an eviction can be trusted
 * to mean "gone" rather than "the socket blinked".</p>
 *
 * <p>The hub heartbeat is not replaced. It carries state (`VoiceHeartbeatState`) and is the repair
 * channel as well as a keepalive; this carries nothing but presence. They are complementary, and
 * the server counts either as a sign of life.</p>
 *
 * <p><b>The first assertion goes out on join, not an interval later.</b> The window immediately
 * after joining is exactly the one where the hub may already be down and the client has yet to
 * notice - waiting 30s leaves that window uncovered for no gain.</p>
 *
 * <p><b>Only `404` and `409` are evictions.</b> They mean the server does not place this device in
 * this room: the participant was swept, the room ended, or another device took the seat. Everything
 * else - a `500`, a gateway hiccup, an offline moment - is a failure of the assertion, not an
 * answer to it, and is ignored. Treating a transient failure as an eviction would turn a blip on a
 * single request into a dropped call, which is worse than the outage it reacted to, and it is the
 * reason this classification is narrow rather than "anything that is not a 2xx".</p>
 *
 * <p>Nothing here tears a room down on its own; it reports through {@link evicted} and stops
 * asserting. The caller owns the local teardown, because it owns the media.</p>
 *
 * <p><b>Read this before wiring it up on desktop.</b> `src-tauri/src/media/voice/liveness.rs`
 * already posts to the same two routes on the same 30s cadence, from a tokio timer the OS cannot
 * throttle, for exactly as long as the voice publication is held - and that file's header argues
 * against a webview ping in as many words, because a renderer timer is the thing whose
 * unreliability caused the bug it fixes. So this service is the answer for the surfaces that have
 * no Rust side (the browser build, and any target publishing from the webview), not a second ping
 * to run alongside it. Starting both for one room doubles the request rate and asserts nothing the
 * dependable one did not already assert.</p>
 *
 * <p>The other deliberate difference from the Rust twin: it logs a refusal and keeps the media up,
 * on the grounds that a room disagreeing about us does not make the audio already flowing less
 * real. This one reports it, because the webview is where the roster and the tiles live and a
 * client nobody can see is worth showing the user. Whoever consumes {@link evicted} inherits that
 * judgement - it is a teardown of our own view of the room, not a reason to kill a publication
 * Rust is still making.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceLivenessService implements OnDestroy {
    private readonly guildVoice = inject(GuildVoiceService);
    private readonly voiceService = inject(VoiceService);

    /** scopeKey -> the room being asserted, with the handle that stops it. */
    private readonly rooms = new Map<string, LiveRoom>();

    private readonly evictedSubject = new Subject<WatchScope>();

    /**
     * Fires when the server has said this device is not in the room, and only then.
     *
     * <p>The ticker for that room is already stopped by the time this emits, so a subscriber is
     * free to call {@link stop} again - it is a no-op - and free to do the teardown synchronously.
     * A failure that is not an eviction never reaches here.</p>
     */
    readonly evicted: Observable<WatchScope> = this.evictedSubject.asObservable();

    ngOnDestroy(): void {
        for (const room of this.rooms.values()) clearInterval(room.timer);
        this.rooms.clear();
    }

    /**
     * Begins asserting liveness for a room, starting immediately.
     *
     * <p>Idempotent per room: a second call for a room already held is ignored rather than arming a
     * second interval. Two tickers would double the request rate and survive the single {@link stop}
     * the caller makes.</p>
     */
    start(scope: WatchScope): void {
        const key = scopeKey(scope);
        if (this.rooms.has(key)) return;

        const timer = setInterval(() => this.assert(scope), VOICE_ALIVE_INTERVAL_MS);
        this.rooms.set(key, {scope, timer});
        // After the map write, so an eviction on this very first assertion finds a room to stop.
        this.assert(scope);
    }

    /**
     * Stops asserting for a room - it was left, or it evicted us.
     *
     * <p>Nothing is sent on the way out: leaving is its own route, and a client that has already
     * been evicted has nothing to say.</p>
     */
    stop(scope: WatchScope): void {
        const key = scopeKey(scope);
        const room = this.rooms.get(key);
        if (!room) return;
        clearInterval(room.timer);
        this.rooms.delete(key);
    }

    private assert(scope: WatchScope): void {
        const request =
            scope.kind === 'channel'
                ? this.guildVoice.alive(scope.guildId, scope.channelId)
                : this.voiceService.alive(scope.callId);

        request.subscribe({
            next: () => void 0,
            error: (error: unknown) => this.onFailure(scope, error),
        });
    }

    /**
     * Classify a failed assertion. Everything that is not an explicit refusal is left alone, and
     * the next tick simply tries again.
     */
    private onFailure(scope: WatchScope, error: unknown): void {
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        if (status !== 404 && status !== 409) return;

        this.stop(scope);
        this.evictedSubject.next(scope);
    }
}
