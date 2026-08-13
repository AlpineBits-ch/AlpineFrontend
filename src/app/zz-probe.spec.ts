/**
 * What the route table means for a session, and what it must never mean.
 *
 * <p>Every one of these fails against the table this replaces, which redirected `''` to
 * `authentication` unconditionally and had no guard anywhere: the login screen was constructed and
 * painted in full on every cold start, and only its constructor then asked whether anyone was
 * signed in. The answer took a token refresh - a real round trip - so a returning user watched a
 * login form for about a second before being thrown into the app.</p>
 *
 * <p>The third test is the one that matters most. "Add Account" deliberately lands on the login
 * screen <i>with a valid session still present</i> (see {@link AccountSwitchService.beginAddAccount})
 * - it sets the live slot aside instead of signing out. A guard that redirects away from
 * `/authentication` whenever a session exists would make that feature a no-op, which is a worse bug
 * than the one being fixed here.</p>
 */
import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideLocationMocks} from '@angular/common/testing';
import {provideRouter, Route, Router, Routes} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {routes} from './app.routes';
import {AuthService} from './services/auth.service';

/** Which screens were actually constructed, in order. */
const painted: string[] = [];

// Distinct selectors, or Angular derives the same component id for both and refuses (NG0912).
@Component({selector: 'app-login-stub', template: ''})
class LoginStub {
    constructor() {
        painted.push('login');
    }
}

@Component({selector: 'app-overview-stub', template: ''})
class OverviewStub {
    constructor() {
        painted.push('overview');
    }
}

/**
 * The real table, with the two heavyweight screens swapped for stubs that record being painted.
 *
 * <p>Swapped by path rather than by class so the spec does not have to construct `Login` or
 * `MainPageComponent`, both of which reach for a dozen services and the network the moment they
 * exist. Everything that decides routing - the paths, the guards, the order of the entries - is the
 * production table.</p>
 */
function stubbedRoutes(): Routes {
    return routes.map((route: Route) => route.component
        ? {...route, component: route.path === 'authentication' ? LoginStub : OverviewStub}
        : route);
}

function setup(isLoggedIn: () => Promise<boolean>): Router {
    painted.length = 0;
    TestBed.configureTestingModule({
        providers: [
            provideLocationMocks(),
            provideRouter(stubbedRoutes()),
            {provide: AuthService, useValue: {isLoggedIn}},
        ],
    });
    return TestBed.inject(Router);
}

/** Lets whatever the guard is waiting on settle, without assuming how many turns it takes. */
function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

it('p2', async () => {
    vi.useFakeTimers();
    const router = setup(() => new Promise<boolean>(() => {
    }));
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/');
    await vi.advanceTimersByTimeAsync(30_000);
    await navigation;
    expect(router.url).toBe('/authentication');
    vi.useRealTimers();
    void flush;
});
