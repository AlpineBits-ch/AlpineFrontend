import {Injectable, signal} from '@angular/core';

/**
 * How far off the machine's clock is from the server's, in milliseconds (`serverNow - clientNow`).
 *
 * Read from the `Date` response header, which the gateway must expose with
 * `Access-Control-Expose-Headers: Date` or nothing trains and the offset silently stays 0.
 * Accurate to roughly ±(500 ms + RTT/2), so it must never be used for message ordering.
 */
@Injectable({providedIn: 'root'})
export class ServerClockService {
    /** `serverNow - clientNow`. Zero until a response has been seen, which is also correct for a machine whose clock is right. */
    private readonly _offsetMs = signal(0);
    readonly offsetMs = this._offsetMs.asReadonly();

    /** Whether the offset has ever been set from a real reading, so a surface can tell "the clocks agree" from "we have not looked yet". */
    private readonly _trained = signal(false);
    readonly trained = this._trained.asReadonly();

    /** Server-corrected wall clock, epoch ms. A plain method rather than a signal, because it changes continuously. */
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
     * The comparison point is the midpoint of the two local readings, the NTP assumption, so a slow
     * request does not read as a clock error. A reading is only adopted when it moves the offset by
     * more than a second, below which it is noise and would wake every consumer on every response.
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
