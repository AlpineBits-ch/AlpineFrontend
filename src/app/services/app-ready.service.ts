import {inject, Injectable, signal} from '@angular/core';
import {NavigationEnd, Router} from '@angular/router';
import {filter, take} from 'rxjs';

/** The longest the splash may stay up, whatever else happens. Exported so the spec asserts the same number. */
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
     * The reveal must hang off the first `NavigationEnd`, which cannot arrive before the session
     * decision resolves. `/overview` is left alone: {@link MainPageComponent} marks itself ready.
     * The safety net is armed here, not inside the subscription, or a navigation that never
     * completes would never arm it.
     */
    revealWhenRouted(): void {
        this.safetyNet ??= setTimeout(() => this.markReady(), SPLASH_SAFETY_NET_MS);

        this.router.events
            .pipe(
                filter(e => e instanceof NavigationEnd),
                take(1),
            )
            .subscribe(() => {
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
