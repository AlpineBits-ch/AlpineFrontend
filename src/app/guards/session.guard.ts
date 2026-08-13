import {inject} from '@angular/core';
import {CanMatchFn, Router} from '@angular/router';
import {AuthService} from '../services/auth.service';

/**
 * How long the router will wait for the session answer before deciding there is not one.
 *
 * <p>The answer normally costs one token refresh, so this is not a latency budget - it is the
 * ceiling for the case where that POST never comes back at all. A dead connection can leave an
 * `HttpClient` request outstanding until the OS gives up on the socket, and a guard that waits that
 * long blocks the navigation behind it: the splash comes down on its own safety net and uncovers a
 * router outlet with nothing in it. Landing on the login screen instead is what already happened
 * whenever a refresh failed, and it is recoverable by hand.</p>
 *
 * <p>Deliberately shorter than `SPLASH_SAFETY_NET_MS`, so the routing decision always settles
 * before the splash gives up waiting for it.</p>
 */
export const SESSION_DECISION_TIMEOUT_MS = 6_000;

/**
 * Whether this launch has a session, answered before the app is drawn.
 *
 * <p><b>It guards `/overview`, and `''` redirects there.</b> The decision really belongs to `''` -
 * that is the URL with two meanings - but a route cannot carry both a `redirectTo` and a guard;
 * Angular rejects the config outright, because redirects are resolved while the URL is still being
 * recognised. So the empty URL redirects unconditionally to the app, and this is what stands in
 * front of it. Nothing is painted in between: the redirect and this guard both run during
 * recognition, long before any component is instantiated.</p>
 *
 * <p><b>A `CanMatch` rather than a `CanActivate`.</b> Both run before the component exists, so
 * either would fix the flash. `canMatch` is the earlier of the two - it decides whether the URL
 * even <i>means</i> this route, so a session-less launch never resolves `/overview` to a component
 * at all - and it is the one that composes: a second entry for the same path is how the router is
 * meant to express "this URL means something else for this visitor", should `/overview` ever need
 * a second meaning.</p>
 *
 * <p><b>Not applied to `/authentication`, on purpose.</b> Being signed in is not a reason to keep
 * anyone off the login screen: "Add Account" sets the live account aside <i>without</i> signing it
 * out and lands there with a perfectly valid session still present - see
 * `AccountSwitchService.beginAddAccount`. A guard that bounced that navigation back to `/overview`
 * would turn the whole feature into a page reload that does nothing, which is how it behaved once
 * before for a different reason. The login screen is only ever reached deliberately, so it needs
 * no protection.</p>
 *
 * <p>Costs at most one network call per launch even though a redirect makes the router consult it
 * more than once: {@link AuthService.refresh} hands every concurrent caller the same in-flight
 * promise, and once that has resolved the access token is valid and `isLoggedIn` answers without
 * any request at all.</p>
 */
export const hasSession: CanMatchFn = () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return decideSession(() => auth.isLoggedIn())
        .then(signedIn => signedIn || router.parseUrl('/authentication'));
};

/**
 * The waiting, separated from the injection so it can be driven directly.
 *
 * <p>Never rejects and never stays pending. A guard that does either is a navigation that ends in
 * an error or does not end at all, and both present to the user as an app that launched into a
 * blank window.</p>
 */
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
