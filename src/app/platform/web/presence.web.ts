import type {Activity} from '../../models/activity.model';
import {Presence, PresenceRpcStatus} from '../ports/presence.port';

/**
 * A browser cannot enumerate processes or bind a named socket, so this host detects nothing and
 * publishes nothing.
 *
 * <p>The app still renders <i>other people's</i> activity - that arrives over the API like any other
 * profile field and never touches this port. What is absent is only the producing half, which is
 * exactly the split `RichPresenceService` already documents for mobile.</p>
 *
 * <p><b>Reads answer "nothing", writes reject.</b> {@link current} and {@link scan} finding nothing is
 * the literal truth on a host with no detection, and it is also what the port documents for a build
 * with no presence module - so a caller that acts on them clears its presence, which is right. The RPC
 * pair is different: a `PresenceRpcStatus` is a claim about a socket, `running: true` would be a lie,
 * and `running: false` would read as "I stopped it for you". They reject instead.</p>
 *
 * <p>The Activity settings page must therefore be <b>disabled with a stated reason</b> rather than
 * hidden - see `activity-settings.component.ts`, whose whole comment block is about a toggle that
 * stayed enabled over calls like these.</p>
 */
export class WebPresence extends Presence {
    readonly supported = false;

    current(): Promise<Activity[]> {
        return Promise.resolve([]);
    }

    /** Resolves to a real unsubscribe so teardown does not have to special-case the host. */
    onChanged(_handler: (activities: Activity[]) => void): Promise<() => void> {
        return Promise.resolve(() => undefined);
    }

    scan(): Promise<string | null> {
        return Promise.resolve(null);
    }

    rpcStart(_mode: 'proxy' | 'exclusive'): Promise<PresenceRpcStatus> {
        return unsupported('rpcStart');
    }

    rpcStop(): Promise<PresenceRpcStatus> {
        return unsupported('rpcStop');
    }
}

function unsupported(operation: string): Promise<never> {
    return Promise.reject(new Error(
        `Presence.${operation}() is desktop-only; a browser cannot bind discord-ipc-0. ` +
        'Gate on Presence.supported or PlatformCapabilities.richPresence.',
    ));
}
