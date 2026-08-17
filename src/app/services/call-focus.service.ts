import {Injectable, signal} from '@angular/core';

/** How long an unrequested focus stays live. Long enough for a stalled join negotiation, short enough that an unconsumed request cannot ambush an unrelated later join. */
const REQUEST_TTL_MS = 120_000;

/** Lets a caller outside the call stage say "focus this share" without reaching into `CallScreenLayoutComponent`, its only reader. One request is held at a time, not queued: a second `request()` replaces the first. */
@Injectable({providedIn: 'root'})
export class CallFocusService {
    private readonly _requested = signal<{scopeKey: string; shareId?: string; userId?: string; expiresAt: number} | null>(null);

    readonly requested = this._requested.asReadonly();

    /** Arms a request. Identify the target by whichever side the caller has: a share id when it already knows which stream, a user id when it only knows whose. */
    request(scopeKey: string, target: {shareId?: string; userId?: string}): void {
        this._requested.set({scopeKey, ...target, expiresAt: Date.now() + REQUEST_TTL_MS});
    }

    /** Returns and clears the request, but only for the matching scope: one-shot, so it cannot re-fire on every render, and a request for a different scope is left untouched for its own reader. */
    consume(scopeKey: string): {shareId?: string; userId?: string} | null {
        const pending = this._requested();
        if (!pending || pending.scopeKey !== scopeKey) return null;

        this._requested.set(null);
        if (Date.now() >= pending.expiresAt) return null;

        const {shareId, userId} = pending;
        return {shareId, userId};
    }
}
