import {computed, Injectable, signal} from '@angular/core';

/**
 * Whether the user has sent the floating call tile away.
 *
 * <p>A root service rather than state inside the tile, because the control that brings it back is
 * not on the tile - it cannot be, the tile is gone. That control lives in the sidebar voice bar,
 * which is already the always-present call indicator, and the two components sit in different
 * feature areas with no view relationship at all.</p>
 *
 * <p><b>The dismissal is keyed to the session, not a bare boolean.</b> Sending the tile away for a
 * voice channel you are idling in must not silently suppress it for the call you join afterwards -
 * that would read as the feature being broken, with nothing on screen to explain why. The key is the
 * mini-player's stage key, and {@link CallMiniPlayerComponent} clears it whenever that key changes,
 * so a dismissal covers exactly one session and no more.</p>
 */
@Injectable({providedIn: 'root'})
export class CallMiniPlayerService {
    private readonly _dismissedKey = signal<string | null>(null);

    /** The session the tile was dismissed for, or null when it should be showing. */
    readonly dismissedKey = this._dismissedKey.asReadonly();

    /** For the restore affordance, which only needs to know that *something* was dismissed. */
    readonly isDismissed = computed(() => this._dismissedKey() !== null);

    /** Sends the tile away for one session. A null key dismisses nothing - there is no session. */
    dismiss(key: string | null): void {
        if (key !== null) this._dismissedKey.set(key);
    }

    /** Brings it back, from the sidebar voice bar or from the session changing underneath it. */
    restore(): void {
        this._dismissedKey.set(null);
    }
}
