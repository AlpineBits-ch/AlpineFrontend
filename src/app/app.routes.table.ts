import {Type} from "@angular/core";
import {Routes} from "@angular/router";
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
 *
 * <p><b>Why the screens are parameters.</b> So that a spec can drive the real table with stand-ins.
 * `app.routes.ts` names `Login` and `MainPageComponent`, and importing it pulls in the whole
 * application graph behind them: at runtime that costs a spec nothing, because the router only
 * matches the stand-ins and never constructs either screen, but it puts every module in the app
 * into that spec's bundle. The test runner builds one bundle for all the specs together, and
 * enlarging one entry that far rearranges the chunks the others share - which was observed
 * initialising a chunk before the constants it holds existed, and failing three unrelated guild
 * suites on a value that had nothing to do with routing. The table is the part worth asserting;
 * naming the two screens is the part that has to stay out of a spec.</p>
 */
export function appRoutes(login: Type<unknown>, overview: Type<unknown>): Routes {
    return [
        {path: 'authentication', component: login},
        {path: 'overview', component: overview, canMatch: [hasSession]},
        {path: '', redirectTo: 'overview', pathMatch: 'full'},
    ];
}
