import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideLocationMocks} from '@angular/common/testing';
import {provideRouter, Router} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {appRoutes} from './app.routes.table';
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

/** The production table with the two screens stood in for. */
function setup(isLoggedIn: () => Promise<boolean>): Router {
    painted.length = 0;
    TestBed.configureTestingModule({
        providers: [
            provideLocationMocks(),
            provideRouter(appRoutes(LoginStub, OverviewStub)),
            {provide: AuthService, useValue: {isLoggedIn}},
        ],
    });
    return TestBed.inject(Router);
}

/** Lets whatever the guard is waiting on settle, without assuming how many turns it takes. */
function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/** Set while a test holds the session answer back. The teardown must release it too, or it leaks into the next TestBed. */
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
    // The "Add Account" case: the live slot is set aside and the previous account is still signed in.
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
    setup(
        () =>
            new Promise<boolean>(resolve => {
                held = resolve;
            }),
    );
    const harness = await RouterTestingHarness.create();

    const navigation = harness.navigateByUrl('/');
    await flush();
    // No screen exists yet, so there is nothing for the user to misread as "please sign in".
    expect(painted).toEqual([]);

    held!(true);
    held = null;
    await navigation;
    expect(painted).toEqual(['overview']);
});

it('treats a session question that never gets answered as no session', async () => {
    vi.useFakeTimers();
    const router = setup(() => new Promise<boolean>(() => {}));
    const harness = await RouterTestingHarness.create();

    const navigation = harness.navigateByUrl('/');
    // Past SESSION_DECISION_TIMEOUT_MS, which is the only thing that can end this one.
    await vi.advanceTimersByTimeAsync(30_000);
    await navigation;

    // A refresh hanging on a dead connection would otherwise block the navigation indefinitely.
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
