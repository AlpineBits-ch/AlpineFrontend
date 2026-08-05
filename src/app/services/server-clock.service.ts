import {Injectable, signal} from '@angular/core';

/**
 * How far off the machine's clock is from the server's, in milliseconds
 * (`serverNow - clientNow`).
 *
 * <p><b>Why this exists.</b> Rich presence sends an absolute `startedAt` and the client subtracts
 * it from "now" to render "for 23 minutes". If "now" is the local clock and the local clock is
 * wrong — which on desktop is common enough to be a support category, between dual-boot RTC
 * disagreements, a dead CMOS battery and a manually-set timezone — the elapsed timer is wrong by
 * exactly that error. A user whose clock is three hours fast renders "for 3 hours" on a game they
 * launched a minute ago, and there is nothing about the value that looks wrong enough to doubt.</p>
 *
 * <p><b>The source.</b> Nothing else in this app knows the server's time. There is no ping/pong, no
 * `serverTime` field on any payload, and the SignalR hub sends nothing timestamped —
 * `IsleSelfPosition.timestampMs` is the closest thing and its own docblock disqualifies it
 * ("ordering/dedupe ONLY - not a wall clock"). So the reading is taken from the `Date` header every
 * HTTP response already carries, by {@link serverClockInterceptor}, which is the only caller of
 * {@link adopt}.
 *
 * <p><b>Why that needs a server header.</b> `Date` is not one of the CORS-safelisted response
 * headers (`Cache-Control`, `Content-Language`, `Content-Length`, `Content-Type`, `Expires`,
 * `Last-Modified`, `Pragma`), and this client is always cross-origin — the Tauri webview on
 * `tauri://localhost` and the web app on `app.venta.gg`, both against `api.venta.gg`. The gateway
 * must therefore send <code>Access-Control-Expose-Headers: Date</code> for the value to be readable
 * from JavaScript at all. The header itself is present on every response and parses cleanly
 * (`Date.parse` handles the RFC 1123 form the server emits); it is only the CORS exposure that
 * gates it.</p>
 *
 * <p>Written so that not having it is survivable rather than broken: a response whose `Date` cannot
 * be read trains nothing, {@link trained} stays false, the offset stays 0, and every elapsed timer
 * falls back to the local clock. That is the behaviour that shipped before this class existed, so
 * the un-exposed case costs accuracy on an already-wrong clock and nothing else — which is also why
 * this must never be made a hard dependency of rendering.</p>
 *
 * <p><b>What it is not.</b> This is not an NTP client and does not try to be. `Date` has one-second
 * granularity and a response is only observed after a round trip, so the offset is accurate to
 * roughly ±(500 ms + RTT/2). That is irrelevant at the resolution anything here renders — the
 * smallest unit on screen is a second, and the failure mode being corrected is measured in hours.
 * It deliberately does <b>not</b> get used for message ordering or anything else that would care
 * about sub-second accuracy.</p>
 */
@Injectable({providedIn: 'root'})
export class ServerClockService {
    /**
     * `serverNow - clientNow`. Zero until a response has been seen, which is also the correct
     * value for a machine whose clock is right — so the untrained state degrades to "trust the
     * local clock" rather than to a visible error.
     */
    private readonly _offsetMs = signal(0);
    readonly offsetMs = this._offsetMs.asReadonly();

    /**
     * Whether the offset has ever been set from a real reading.
     *
     * <p>Exposed so a surface can tell "the clocks agree" from "we have not looked yet". Nothing
     * currently renders differently on it; it exists so that a future "your clock is off by 3h"
     * hint has something truthful to key on.</p>
     */
    private readonly _trained = signal(false);
    readonly trained = this._trained.asReadonly();

    /**
     * Server-corrected wall clock, epoch ms.
     *
     * <p>Deliberately a plain method rather than a signal: it changes continuously, and a signal
     * that changes continuously either lies or invalidates the whole graph every millisecond. The
     * thing that ticks is {@link ActivityTickerService}, which samples this.</p>
     */
    now(): number {
        return Date.now() + this._offsetMs();
    }

    /** Applies the offset to a server-issued timestamp's local equivalent. */
    elapsedSince(startedAtEpochMs: number): number {
        return this.now() - startedAtEpochMs;
    }

    /**
     * Records one observation of the server's clock.
     *
     * @param serverEpochMs   the response's `Date` header, parsed.
     * @param requestSentAtMs local time the request left, by the local clock.
     * @param responseAtMs    local time the response arrived, by the local clock.
     *
     * <p>The server generated its timestamp somewhere inside the round trip, so the honest local
     * comparison point is the midpoint of the two local readings rather than either end — the same
     * assumption NTP makes, for the same reason, and it halves the error contributed by a slow
     * request.</p>
     *
     * <p>Readings are only adopted when they move the offset by more than a second. Below that the
     * difference is inside the noise floor of a one-second-granularity header, and adopting it
     * would make {@link offsetMs} a signal that changes on every HTTP response — waking every
     * consumer for a correction too small to render.</p>
     */
    adopt(serverEpochMs: number, requestSentAtMs: number, responseAtMs: number): void {
        if (!Number.isFinite(serverEpochMs)) return;

        const localMidpoint = requestSentAtMs + (responseAtMs - requestSentAtMs) / 2;
        const observed = serverEpochMs - localMidpoint;

        if (this._trained() && Math.abs(observed - this._offsetMs()) < 1_000) return;

        this._offsetMs.set(observed);
        this._trained.set(true);
    }
}
