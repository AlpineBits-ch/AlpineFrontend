/**
 * Launching with the OS. Desktop-only.
 *
 * On web the setting must be disabled with a stated reason, never hidden.
 */
export abstract class Autostart {
    /** False on web. Drives the disabled-with-a-reason state. */
    abstract readonly supported: boolean;

    abstract isEnabled(): Promise<boolean>;

    abstract setEnabled(enabled: boolean): Promise<void>;
}
