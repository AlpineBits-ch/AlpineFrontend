import {Routes} from "@angular/router";
import {Login} from "./features/login/login.component";
import {MainPageComponent} from "./features/main-page/main-page.component";
import {hasSession} from "./guards/session.guard";

/**
 * Where a launch goes, decided before anything is drawn.
 *
 * <p>`''` used to redirect straight to `authentication` and there was no guard anywhere, so the
 * session question was asked by the login screen's own constructor - which means the whole login
 * form was built and painted before anyone could find out it was the wrong screen. The answer takes
 * a token refresh, so a returning user read "Sign in" for about a second on every single launch and
 * was then thrown into the app.</p>
 *
 * <p>Now `''` means the app, and {@link hasSession} stands in front of it and sends a launch with no
 * session to the login screen instead. Both steps happen while the URL is still being recognised,
 * so neither screen is instantiated until the right one is known. The decision would read better on
 * the `''` entry itself, but a route cannot carry both a `redirectTo` and a guard - see
 * {@link hasSession}.</p>
 *
 * <p>`authentication` is deliberately unguarded. Also {@link hasSession}.</p>
 */
export const routes: Routes = [
    {path: 'authentication', component: Login},
    {path: 'overview', component: MainPageComponent, canMatch: [hasSession]},
    {path: '', redirectTo: 'overview', pathMatch: 'full'},
];
