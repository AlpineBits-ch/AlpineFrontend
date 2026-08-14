import {Injectable, signal} from '@angular/core';

/**
 * How long an unrequested focus stays live.
 *
 * <p>Every watch entry point (a LIVE badge click, a go-live notification, join-and-watch from the
 * lobby) now joins voice before arming the request, so the common path consumes it well within a
 * second. This TTL exists for the slow path: join negotiation can stall, and a request that lapses
 * mid-negotiation is a silent failure - the user lands on the stage unfocused with no error. 120
 * seconds is comfortably longer than any realistic join takes, while still being short enough that a
 * request nobody ever consumes (the join itself failed, or the user navigated away) does not sit
 * around to ambush an unrelated later join.</p>
 */
const REQUEST_TTL_MS = 120_000;

/**
 * Lets a caller outside the call stage say "focus this share" - a notification action, a
 * click-to-watch, the mini-player - without reaching into `CallScreenLayoutComponent`, whose
 * `maximizedId` stays private. `CallScreenLayoutComponent` is the only reader: it consumes a
 * request that matches its own `watchScope`, resolving a `userId` to a share itself.
 *
 * <p>One request is held at a time, not queued. A second `request()` before the first is consumed
 * simply replaces it - the caller only ever wants the most recent "look at this", never a backlog
 * of stale ones to play out in order.</p>
 */
@Injectable({providedIn: 'root'})
export class CallFocusService {
    private readonly _requested = signal<{scopeKey: string; shareId?: string; userId?: string; expiresAt: number} | null>(null);

    readonly requested = this._requested.asReadonly();

    /** Arms a request. Identify the target by whichever side the caller has - a share id when it
     *  already knows which stream, a user id when it only knows whose. */
    request(scopeKey: string, target: {shareId?: string; userId?: string}): void {
        this._requested.set({scopeKey, ...target, expiresAt: Date.now() + REQUEST_TTL_MS});
    }

    /**
     * Returns and clears the request, but only for the matching scope - one-shot, so a focus
     * request cannot re-fire on every render.
     *
     * <p>A request for a different scope is left untouched: it is not this caller's to consume, and
     * the layout instance it does belong to has not had a chance to read it yet.</p>
     *
     * <p>An expired request is dropped and returns null exactly as if nothing had been requested -
     * see {@link REQUEST_TTL_MS}.</p>
     */
    consume(scopeKey: string): {shareId?: string; userId?: string} | null {
        const pending = this._requested();
        if (!pending || pending.scopeKey !== scopeKey) return null;

        this._requested.set(null);
        if (Date.now() >= pending.expiresAt) return null;

        const {shareId, userId} = pending;
        return {shareId, userId};
    }
}
