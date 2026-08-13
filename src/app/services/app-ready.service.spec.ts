/**
 * When the splash is allowed to come down.
 *
 * <p>It used to come down on a 300 ms timer started at the first `NavigationEnd`, which was fine
 * only because nothing was ever pending: the router matched the login screen immediately and asked
 * about the session afterwards. Now the session question is answered <i>during</i> routing, so the
 * splash has to stay up for however long that takes - a timer measured from a navigation that has
 * not happened yet hides nothing.</p>
 */
import {Component, inject, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideLocationMocks} from '@angular/common/testing';
import {CanMatchFn, provideRouter, Router} from '@angular/router';
import {AppReadyService, SPLASH_SAFETY_NET_MS} from './app-ready.service';

@Component({selector: 'app-route-stub', template: ''})
class RouteStub {
}

/** Whether there is a session yet, controlled per test. */
const gate = signal<Promise<boolean>>(Promise.resolve(true));

/**
 * Releases a gate a test deliberately left hanging.
 *
 * <p>Set by {@link pending}, called by the teardown. A navigation left outstanding when the file
 * ends is a continuation that resolves inside somebody else's `TestBed`, which surfaces as an
 * unrelated spec failing to configure its own testing module.</p>
 */
let release: (() => void) | null = null;

/** A session answer that will not arrive until the test is over. */
function pending(): void {
    gate.set(new Promise<boolean>(resolve => {
        release = () => resolve(false);
    }));
}

/**
 * Shaped exactly like `hasSession`, including the redirect being a `UrlTree` the guard hands back
 * rather than a `redirectTo` on the route. That difference decides whether a `NavigationEnd` ever
 * arrives for the screen the user ends up on, which is the only thing this service listens for.
 */
const sessionGate: CanMatchFn = () => {
    const router = inject(Router);
    return gate().then(signedIn => signedIn || router.parseUrl('/authentication'));
};

/** The service under test, remembered only so the teardown can disarm its safety net. */
let live: AppReadyService | null = null;

function setup(): {ready: AppReadyService; router: Router} {
    TestBed.configureTestingModule({
        providers: [
            provideLocationMocks(),
            provideRouter([
                {path: 'authentication', component: RouteStub},
                {path: 'overview', component: RouteStub, canMatch: [sessionGate]},
                {path: '', pathMatch: 'full', redirectTo: 'overview'},
            ]),
        ],
    });
    live = TestBed.inject(AppReadyService);
    return {ready: live, router: TestBed.inject(Router)};
}

function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(async () => {
    vi.useRealTimers();
    release?.();
    release = null;
    // Also disarms the eight-second safety net, which the tests that leave the splash up would
    // otherwise leave ticking into whichever spec file this worker picks up next.
    live?.markReady();
    live = null;
    await flush();
    gate.set(Promise.resolve(true));
});

it('holds the splash up while the routing decision is still pending', async () => {
    pending();
    const {ready, router} = setup();

    ready.revealWhenRouted();
    void router.navigateByUrl('/');
    await flush();

    expect(ready.ready()).toBe(false);
});

it('takes the splash down once routing has settled on the login screen', async () => {
    gate.set(Promise.resolve(false));
    const {ready, router} = setup();

    ready.revealWhenRouted();
    await router.navigateByUrl('/');

    // The guard sent this one somewhere else mid-navigation, so the NavigationEnd being waited on
    // is the redirected one. If that event never arrived, every signed-out launch would sit behind
    // the splash until the safety net fired.
    expect(router.url).toBe('/authentication');
    expect(ready.ready()).toBe(true);
});

it('leaves the splash to MainPageComponent when routing lands on the app', async () => {
    const {ready, router} = setup();

    ready.revealWhenRouted();
    await router.navigateByUrl('/overview');

    // MainPageComponent marks ready itself, at the end of its launch sequence. Taking the splash
    // down here instead would uncover a shell that has not loaded anything yet.
    expect(ready.ready()).toBe(false);
});

it('never leaves anyone staring at the splash for ever', async () => {
    vi.useFakeTimers();
    pending();
    const {ready, router} = setup();

    ready.revealWhenRouted();
    void router.navigateByUrl('/');
    await vi.advanceTimersByTimeAsync(SPLASH_SAFETY_NET_MS + 1);

    // The safety net is armed straight away rather than at the first NavigationEnd: a navigation
    // that never completes is exactly the case it exists for, and one armed from inside that
    // event would never be armed at all.
    expect(ready.ready()).toBe(true);
});
