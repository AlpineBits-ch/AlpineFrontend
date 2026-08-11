import {Autostart} from '../ports/autostart.port';

/**
 * `plugin-autostart`, which writes the platform's own launch-at-login entry - a registry `Run` key on
 * Windows, a launch agent on macOS, a `.desktop` file on Linux.
 */
export class TauriAutostart extends Autostart {
    readonly supported = true;

    /**
     * What the OS actually has registered, which is not necessarily what the account setting says.
     *
     * <p>The two can disagree: the setting round-trips through the server and follows the user to a
     * second machine, while the registration is per-machine. Reading it is the only way to reconcile
     * them.</p>
     */
    async isEnabled(): Promise<boolean> {
        const {isEnabled} = await import('@tauri-apps/plugin-autostart');
        return isEnabled();
    }

    async setEnabled(enabled: boolean): Promise<void> {
        const {disable, enable} = await import('@tauri-apps/plugin-autostart');
        await (enabled ? enable() : disable());
    }
}
