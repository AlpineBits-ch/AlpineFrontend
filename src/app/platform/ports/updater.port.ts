/** A release the host is willing to install over itself. Mirrors `UpdateInfo` in `update.service.ts`. */
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
 * Replacing the running app with a newer one. Desktop-only; the updater page is hidden on web.
 *
 * This is the in-app check. The pre-launch update gate is a separate, NSIS-only path.
 */
export abstract class Updater {
    /** False on web. Callers hide the updater surface entirely. */
    abstract readonly supported: boolean;

    /** Null when already current. Rejects only when the check itself failed. */
    abstract check(): Promise<AvailableUpdate | null>;

    /**
     * Download and install the update {@link check} last returned, then relaunch.
     *
     * Does not resolve on success: the process is replaced.
     */
    abstract downloadAndInstall(onProgress?: (p: UpdateProgress) => void): Promise<void>;
}
