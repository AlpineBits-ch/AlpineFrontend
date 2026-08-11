/**
 * Launching with the OS.
 *
 * <p><b>Desktop-only.</b> Nothing in a browser can register itself to start with the machine, so the
 * web adapter reports `supported = false`, {@link isEnabled} answers false, and the setting must be
 * *disabled with a stated reason* rather than hidden - a user goes looking for "start with Windows",
 * and a toggle that moves and does nothing is the precedent
 * `activity-settings.component.ts` exists to warn about.</p>
 *
 * <p>Signature designed here; the design spec names the port without giving one. Taken from the
 * `enable` / `disable` pair `user-settings.service.ts` already imports, plus a read so the stored
 * setting can be reconciled against what the OS actually has registered.</p>
 */
export abstract class Autostart {
    /** False on web. Drives the disabled-with-a-reason state. */
    abstract readonly supported: boolean;

    abstract isEnabled(): Promise<boolean>;

    abstract setEnabled(enabled: boolean): Promise<void>;
}
