import type {PresenceRpcStatus} from '../../services/rich-presence.service';
import type {Activity} from '../../models/activity.model';

/** Unchanged, and re-exported so a caller can depend on this port alone. See `voice-publisher.port.ts`. */
export type {PresenceRpcStatus};

/**
 * Detecting what this machine is doing, and lending out `discord-ipc-0`.
 *
 * <p><b>Desktop-only by platform, not by policy.</b> A browser cannot enumerate processes or bind a
 * named socket, so the web adapter reports `supported = false`, produces nothing, and the app renders
 * other people's activity while never publishing its own. That is exactly the split
 * `RichPresenceService` already documents for mobile.</p>
 *
 * <p>The Activity/game-detection settings must be *disabled with a stated reason* on web rather than
 * hidden: a user goes looking for that switch, and
 * `activity-settings.component.ts:59` already documents leaving a control enabled over a no-op as
 * the bug class to avoid.</p>
 *
 * <p>Signature designed here - the design spec names the port without giving one. Taken from what
 * `RichPresenceService` reaches for natively: `presence_current`, `scan_game_process`,
 * `presence_rpc_start` / `presence_rpc_stop` and the `presence://changed` event.</p>
 */
export abstract class Presence {
    /** False on web. Drives the disabled-with-a-reason state, not a hidden control. */
    abstract readonly supported: boolean;

    /**
     * The arbiter's current state.
     *
     * <p>Needed because {@link onChanged} fires *only on change*: a subscriber arriving mid-game -
     * every sign-in and every webview reload - would otherwise see nothing until the game ended.
     * Empty when there is no presence module in this build.</p>
     */
    abstract current(): Promise<Activity[]>;

    /**
     * Subscribe to the merged detection. Resolves to its own unsubscribe.
     *
     * <p>One event is proof the Rust arbiter exists and is emitting, which is what permanently
     * retires the legacy {@link scan} poll. Registering for an event nobody emits is not an error, so
     * this resolves on a build with no arbiter at all.</p>
     */
    abstract onChanged(handler: (activities: Activity[]) => void): Promise<() => void>;

    /**
     * The legacy single-game poll, for a build with no arbiter.
     *
     * <p>Returns a bare title and nothing else - no start time, no details, no application id. It
     * must not be written on top of arbiter output: a `ProcessScan` sighting compares unequal to a
     * rich RPC activity for the same game, so it would overwrite it on every tick and the presence
     * would visibly flap.</p>
     */
    abstract scan(): Promise<string | null>;

    /**
     * Start the local Discord-compatible RPC server, taking `discord-ipc-0`.
     *
     * <p>Proxy mode relays to the downstream Discord so both clients see the presence. Check
     * {@link PresenceRpcStatus.index} on the result: anything other than 0 means no game will find
     * us this session, because client libraries stop at the first socket that answers.</p>
     */
    abstract rpcStart(mode: 'proxy' | 'exclusive'): Promise<PresenceRpcStatus>;

    abstract rpcStop(): Promise<PresenceRpcStatus>;
}
