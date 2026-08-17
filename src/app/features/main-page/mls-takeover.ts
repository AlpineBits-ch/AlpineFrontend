import {Observable, Subscription} from 'rxjs';

/**
 * What happens when a browser tab is handed an account's encryption engine by a closing tab.
 * `WebMlsEngine` allows one live engine per account per browser profile, held as a Web Lock. A tab
 * that booted while another owned the lock ran its whole launch against an engine that refused
 * everything, and gaining the lock does not repair that, so the grant reruns the device launch.
 */
export interface SessionTakeoverSteps {
    /**
     * Emissions of "this tab now owns the account's engine". Never emits on a host with one process,
     * and never for a first claim; see `MlsService.sessionTakeovers`.
     */
    takeovers: () => Observable<void>;

    /**
     * Runs the device half of the launch sequence again. The whole of it, not a subset: the blocked
     * tab's outcome flags all came from an engine that said no, so none of them can be trusted.
     */
    relaunch: () => Promise<void>;

    /** Where the takeover is recorded. Separated so a spec can read it without a console spy. */
    log?: (message: string) => void;
}

/**
 * Subscribes the relaunch to the takeover. A rejected relaunch must be swallowed rather than escape
 * into the subscription, which would tear it down and leave a later takeover with nothing listening.
 *
 * @returns the subscription, for the caller's teardown.
 */
export function relaunchOnSessionTakeover(steps: SessionTakeoverSteps): Subscription {
    const log = steps.log ?? ((message: string) => console.info(message));

    return steps.takeovers().subscribe(() => {
        log(
            "This tab has been handed the account's encryption engine by a closing tab - running the " +
                'device launch again',
        );
        void steps.relaunch().catch((err: unknown) => {
            console.error('The launch sequence failed after a session takeover', err);
        });
    });
}
