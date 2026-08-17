import type {PresenceRpcStatus} from '../../services/rich-presence.service';
import type {Activity} from '../../models/activity.model';

/** Unchanged, and re-exported so a caller can depend on this port alone. See `voice-publisher.port.ts`. */
export type {PresenceRpcStatus};

/**
 * Detecting what this machine is doing, and lending out `discord-ipc-0`. Desktop-only.
 *
 * The Activity and game-detection settings must be disabled with a stated reason on web, not hidden.
 */
export abstract class Presence {
    /** False on web. Drives the disabled-with-a-reason state, not a hidden control. */
    abstract readonly supported: boolean;

    /** The arbiter's current state, since {@link onChanged} fires only on change. Empty with no module. */
    abstract current(): Promise<Activity[]>;

    /** Subscribe to the merged detection. Resolves to its own unsubscribe. */
    abstract onChanged(handler: (activities: Activity[]) => void): Promise<() => void>;

    /**
     * The legacy single-game poll, for a build with no arbiter. A bare title and nothing else.
     *
     * Must not be written on top of arbiter output, or the presence flaps every tick.
     */
    abstract scan(): Promise<string | null>;

    /**
     * Start the local Discord-compatible RPC server, taking `discord-ipc-0`.
     *
     * Check {@link PresenceRpcStatus.index}: anything other than 0 means no game will find us.
     */
    abstract rpcStart(mode: 'proxy' | 'exclusive'): Promise<PresenceRpcStatus>;

    abstract rpcStop(): Promise<PresenceRpcStatus>;
}
