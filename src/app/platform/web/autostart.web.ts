import {Autostart} from '../ports/autostart.port';

/**
 * Nothing in a browser can register itself to start with the machine.
 *
 * <p>{@link isEnabled} answers false because that is true - no launch entry exists for a web client -
 * and the port documents that answer. {@link setEnabled} rejects: it is the write behind a switch the
 * user flipped, and a resolved promise there is the exact bug the capability rules exist to prevent, a
 * toggle that moves and does nothing. The old code did `.catch(() => {})` around the plugin call under
 * an `isTauri()` guard, which had the same effect only because of the guard; without one it would have
 * silently swallowed this.</p>
 *
 * <p>The setting is <b>disabled with a stated reason</b> rather than hidden, because a user goes
 * looking for "start with Windows" and its absence needs explaining.</p>
 */
export class WebAutostart extends Autostart {
    readonly supported = false;

    isEnabled(): Promise<boolean> {
        return Promise.resolve(false);
    }

    setEnabled(_enabled: boolean): Promise<void> {
        return Promise.reject(new Error(
            'Autostart.setEnabled() is desktop-only; a browser cannot launch with the OS. ' +
            'Gate on Autostart.supported or PlatformCapabilities.autostart.',
        ));
    }
}
