import {AvailableUpdate, Updater, UpdateProgress} from '../ports/updater.port';

/** Tauri's `Update` handle, named without importing the plugin eagerly. */
type PluginUpdate = NonNullable<Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>>;

/**
 * `plugin-updater` plus `plugin-process`, which is the pair that makes an in-place update work: the
 * first swaps the files, the second restarts into them.
 *
 * <p><b>The `Update` handle is held here rather than handed to the caller.</b> That is what keeps the
 * port free of a plugin type - `UpdateService` used to store the plugin's own `Update` object in a
 * field, which is precisely why it could not stop importing the plugin.</p>
 *
 * <p>Not to be confused with the pre-launch update gate, which runs in Rust before the window exists
 * and is NSIS-only - see `project_update_gate_nsis_only`. This is the in-app check.</p>
 */
export class TauriUpdater extends Updater {
    readonly supported = true;

    private pending: PluginUpdate | null = null;

    async check(): Promise<AvailableUpdate | null> {
        const {check} = await import('@tauri-apps/plugin-updater');
        const update = await check();
        this.pending = update;

        if (!update) return null;
        return {
            version: update.version,
            currentVersion: update.currentVersion,
            body: update.body ?? null,
        };
    }

    /**
     * <p>Byte counts are accumulated here because the plugin reports <i>chunk</i> lengths, not a
     * running total, and the content length arrives once in a separate `Started` event. Reporting on
     * `Started` as well as on every chunk is what lets a caller show a real progress bar from the
     * first byte instead of an indeterminate one until the second event.</p>
     */
    async downloadAndInstall(onProgress?: (p: UpdateProgress) => void): Promise<void> {
        const update = this.pending;
        if (!update) throw new Error('No update to install - call check() first');

        let downloaded = 0;
        let total: number | null = null;

        await update.downloadAndInstall(event => {
            if (event.event === 'Started') {
                total = event.data.contentLength ?? null;
            } else if (event.event === 'Progress') {
                downloaded += event.data.chunkLength;
            } else {
                return;
            }
            onProgress?.({downloaded, total});
        });

        const {relaunch} = await import('@tauri-apps/plugin-process');
        await relaunch();
    }
}
