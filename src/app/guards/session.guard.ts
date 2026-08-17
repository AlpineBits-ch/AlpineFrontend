import {inject} from '@angular/core';
import {CanMatchFn, Router} from '@angular/router';
import {AuthService} from '../services/auth.service';

/**
 * How long the router will wait for the session answer before deciding there is not one. Must stay
 * shorter than `SPLASH_SAFETY_NET_MS` so the routing decision settles before the splash gives up.
 */
export const SESSION_DECISION_TIMEOUT_MS = 6_000;

/**
 * Whether this launch has a session, answered before the app is drawn. Guards `/overview` only;
 * `/authentication` must stay unguarded so "Add Account" can reach it with a live session.
 */
export const hasSession: CanMatchFn = () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return decideSession(() => auth.isLoggedIn()).then(
        signedIn => signedIn || router.parseUrl('/authentication'),
    );
};

/** The waiting, separated from the injection. Never rejects and never stays pending. */
export function decideSession(
    isLoggedIn: () => Promise<boolean>,
    timeoutMs: number = SESSION_DECISION_TIMEOUT_MS,
): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const deadline = setTimeout(() => resolve(false), timeoutMs);
        const settle = (answer: boolean) => {
            clearTimeout(deadline);
            resolve(answer);
        };
        isLoggedIn().then(settle, () => settle(false));
    });
}
