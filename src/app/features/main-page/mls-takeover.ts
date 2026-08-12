import {Observable, Subscription} from 'rxjs';

/**
 * What happens when a browser tab is handed an account's encryption engine by a closing tab.
 *
 * <p>Lifted out of `MainPageComponent` as a plain function over its steps, for the same reason
 * {@link runMlsLaunch} and {@link runSignOut} were: the bug is entirely about control flow, and it
 * lived invisibly inside a component nothing can construct without half the application.</p>
 *
 * <h3>The bug</h3>
 *
 * <p>`WebMlsEngine` allows one live engine per account per browser profile, held as a Web Lock. A
 * second tab of the same account is refused every engine command and leaves a request queued, so when
 * the owning tab closes the browser grants it and the adapter is whole again - it restores the blob the
 * other tab left on its next command and carries on.</p>
 *
 * <p><b>The launch sequence is not restored with it.</b> That ran once, at boot, against an engine that
 * refused everything: `autoUnlock` produced no key handle, `processPendingWelcomes` processed nothing,
 * no key packages were uploaded, and the banners it set from that outcome are still up. Nothing issues
 * the "next command" the engine is waiting for either, so the tab sits on "encryption unavailable" with
 * a perfectly good engine underneath it until somebody reloads the page - and a reload is exactly what
 * the queued lock request exists to avoid needing.</p>
 *
 * <p>So the grant is answered by running the device launch again, which is the same recovery the
 * onboarding picker uses when it resumes a launch it suspended. It re-inits storage (which performs the
 * deferred restore), re-unlocks, re-processes Welcomes, re-uploads key packages, and sets <i>or clears</i>
 * every banner from the new outcome - clearing being the half that takes the stale refusal down.</p>
 */
export interface SessionTakeoverSteps {
    /**
     * Emissions of "this tab now owns the account's engine".
     *
     * <p>Never emits on a host with one process, and never for a first claim; see
     * `MlsService.sessionTakeovers`.</p>
     */
    takeovers: () => Observable<void>;

    /**
     * Runs the device half of the launch sequence again.
     *
     * <p>Deliberately the whole of it rather than a chosen subset. Picking steps here would mean
     * deciding, at this distance, which of them the refused launch got far enough to complete - and the
     * blocked tab's outcome flags are exactly the thing that cannot be trusted, since every one of them
     * was derived from an engine that said no.</p>
     */
    relaunch: () => Promise<void>;

    /** Where the takeover is recorded. Separated so a spec can read it without a console spy. */
    log?: (message: string) => void;
}

/**
 * Subscribes the relaunch to the takeover.
 *
 * <p>A rejected relaunch is logged and swallowed rather than allowed to escape into the subscription:
 * an unhandled rejection there would tear down the subscription and leave a later takeover - an account
 * switch, a third tab - with nothing listening. The launch reports its own failures through the banners
 * it sets, which is where a user can act on them.</p>
 *
 * @returns the subscription, for the caller's teardown.
 */
export function relaunchOnSessionTakeover(steps: SessionTakeoverSteps): Subscription {
    const log = steps.log ?? ((message: string) => console.info(message));

    return steps.takeovers().subscribe(() => {
        log(
            'This tab has been handed the account\'s encryption engine by a closing tab - running the '
            + 'device launch again',
        );
        void steps.relaunch().catch((err: unknown) => {
            console.error('The launch sequence failed after a session takeover', err);
        });
    });
}
