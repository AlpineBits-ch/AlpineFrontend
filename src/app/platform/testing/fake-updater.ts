import {AvailableUpdate, Updater, UpdateProgress} from '../ports/updater.port';

/**
 * An {@link Updater} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Defaults to a supported host with nothing newer to offer - `check()` resolving null - because that
 * is the answer that has to stay distinguishable from "this host cannot update itself". A spec asserting
 * the unsupported path should use the real `WebUpdater` rather than setting {@link supported} false here:
 * faking the thing under test would assert the spec's own opinion of what the adapter does.</p>
 */
export class FakeUpdater extends Updater {
    supported = true;

    /** The release this host is holding, or null for "you are current". */
    available: AvailableUpdate | null = null;

    /** Progress reports {@link downloadAndInstall} will emit, in order. */
    progress: UpdateProgress[] = [];

    /** Set to make {@link check} reject the way a network failure does. */
    checkFails = false;

    checks = 0;
    installs = 0;

    async check(): Promise<AvailableUpdate | null> {
        this.checks++;
        if (this.checkFails) throw new Error('could not reach the update server');
        return this.available;
    }

    async downloadAndInstall(onProgress?: (p: UpdateProgress) => void): Promise<void> {
        this.installs++;
        for (const step of this.progress) onProgress?.(step);
    }
}
