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

/**
 * Set while a test is deliberately holding the session answer back.
 *
 * <p>Released by the teardown as well as by the test, because a failed assertion skips the rest of
 * the test body: the navigation would still be outstanding when the file ends, and that
 * continuation resolves inside whichever `TestBed` this worker gets to next.</p>
 */
let held: ((loggedIn: boolean) => void) | null = null;

afterEach(async () => {
    vi.useRealTimers();
    held?.(false);
    held = null;
    await flush();
});

it('sends a cold start with a valid session to the app without painting the login screen', async () => {
    const router = setup(async () => true);
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/');

    expect(router.url).toBe('/overview');
    expect(painted).toEqual(['overview']);
});

it('sends a cold start with no session to the login screen', async () => {
    const router = setup(async () => false);
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/');

    expect(router.url).toBe('/authentication');
    expect(painted).toEqual(['login']);
});

it('leaves a deliberate navigation to the login screen alone, session or no session', async () => {
    // The "Add Account" case: the live slot has been set aside, the previous account is still
    // signed in, and this screen is exactly where the user asked to be.
    const router = setup(async () => true);
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/authentication');

    expect(router.url).toBe('/authentication');
    expect(painted).toEqual(['login']);
});

it('sends /overview without a session to the login screen', async () => {
    const router = setup(async () => false);
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/overview');

    expect(router.url).toBe('/authentication');
    expect(painted).toEqual(['login']);
});

it('paints nothing at all until the session question has been answered', async () => {
    setup(() => new Promise<boolean>(resolve => {
        held = resolve;
    }));
    const harness = await RouterTestingHarness.create();

    const navigation = harness.navigateByUrl('/');
    await flush();
    // The whole point: no screen exists yet, so there is nothing for the splash to be hiding
    // and nothing for the user to see and misread as "please sign in".
    expect(painted).toEqual([]);

    held!(true);
    held = null;
    await navigation;
    expect(painted).toEqual(['overview']);
});

it('treats a session question that never gets answered as no session', async () => {
    vi.useFakeTimers();
    const router = setup(() => new Promise<boolean>(() => {
    }));
    const harness = await RouterTestingHarness.create();

    const navigation = harness.navigateByUrl('/');
    // Past SESSION_DECISION_TIMEOUT_MS, which is the only thing that can end this one.
    await vi.advanceTimersByTimeAsync(30_000);
    await navigation;

    // A refresh that hangs on a dead connection would otherwise block the navigation for as long
    // as the OS takes to give up, leaving an empty shell behind the splash.
    expect(router.url).toBe('/authentication');
});

it('treats a session question that throws as no session', async () => {
    const router = setup(async () => {
        throw new Error('token endpoint unreachable');
    });
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/');

    // A rejected guard is a navigation error, which leaves the router with nothing activated.
    expect(router.url).toBe('/authentication');
});
