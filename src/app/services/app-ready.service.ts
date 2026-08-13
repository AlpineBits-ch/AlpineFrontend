import {inject, Injectable, signal} from '@angular/core';
import {NavigationEnd, Router} from '@angular/router';
import {filter, take} from 'rxjs';

/**
 * The longest the splash may stay up, whatever else happens.
 *
 * <p>Exported so the spec asserts against the same number the app uses rather than a copy of it.</p>
 */
export const SPLASH_SAFETY_NET_MS = 8_000;

@Injectable({providedIn: 'root'})
export class AppReadyService {
    private readonly router = inject(Router);
    private readonly _ready = signal(false);
    readonly ready = this._ready.asReadonly();
    private safetyNet: ReturnType<typeof setTimeout> | null = null;

    /**
     * Takes the splash down once routing has settled somewhere other than the app itself.
     *
     * <p>The splash exists to cover the launch, and since {@link hasSession} the launch includes
     * deciding <i>which screen this is</i> - a decision that costs a token refresh on a cold start.
     * So the reveal hangs off the first `NavigationEnd`, which by construction cannot arrive until
     * that decision has resolved. It used to be a 300 ms timer started at the same event, which was
     * harmless only because nothing was pending back then: the login screen was matched immediately
     * and asked about the session afterwards, so the splash was long gone before the answer came
     * and it hid nothing at all.</p>
     *
     * <p>`/overview` is left alone: {@link MainPageComponent} marks ready at the end of its own
     * launch sequence, because uncovering that shell before it has loaded anything shows an empty
     * app rather than a loading one.</p>
     *
     * <p>The safety net is armed here rather than inside the subscription. A navigation that never
     * completes is precisely the case it exists for, and one armed from the event that would end
     * that navigation would never be armed at all.</p>
     */
    revealWhenRouted(): void {
        this.safetyNet ??= setTimeout(() => this.markReady(), SPLASH_SAFETY_NET_MS);

        this.router.events.pipe(
            filter(e => e instanceof NavigationEnd),
            take(1),
        ).subscribe(() => {
            if (!this.router.url.startsWith('/overview')) this.markReady();
        });
    }

    markReady(): void {
        if (this._ready()) return;
        this._ready.set(true);
        if (this.safetyNet !== null) {
            clearTimeout(this.safetyNet);
            this.safetyNet = null;
        }
        const overlay = document.getElementById('app-loading');
        if (!overlay) return;
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
    }
}
