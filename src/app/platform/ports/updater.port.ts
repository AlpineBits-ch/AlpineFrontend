/**
 * A release the host is willing to install over itself.
 *
 * <p>Mirrors the existing `UpdateInfo` in `update.service.ts`, kept here so the port does not depend
 * on a service that statically imports the updater plugin.</p>
 */
export interface AvailableUpdate {
    version: string;
    currentVersion: string;
    body: string | null;
}

/** Bytes so far and the total, or null while the host has not said how big it is. */
export interface UpdateProgress {
    downloaded: number;
    total: number | null;
}

/**
 * Replacing the running app with a newer one.
 *
 * <p><b>Desktop-only.</b> A web client updates by being reloaded, so the web adapter reports
 * `supported = false`, {@link check} resolves null, and the updater page is *hidden* rather than
 * disabled - its absence needs no explanation.</p>
 *
 * <p>Signature designed here; the design spec names the port without giving one. Taken from
 * `UpdateService`, whose plugin surface is `check()`, `Update.downloadAndInstall(onEvent)` and
 * `relaunch()`. The pre-launch update gate runs before the window is shown and is a separate,
 * NSIS-only path - see `project_update_gate_nsis_only`; this port is the in-app check.</p>
 */
export abstract class Updater {
    /** False on web. Callers hide the updater surface entirely. */
    abstract readonly supported: boolean;

    /** Null when already current. Rejects only when the check itself failed. */
    abstract check(): Promise<AvailableUpdate | null>;

    /**
     * Download and install the update {@link check} last returned, then relaunch.
     *
     * <p>Does not resolve on success: the process is replaced. Treat a resolution as "installed but
     * not relaunched" and a rejection as "still running the old version".</p>
     */
    abstract downloadAndInstall(onProgress?: (p: UpdateProgress) => void): Promise<void>;
}
