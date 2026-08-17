import {inject, Injectable, signal} from '@angular/core';
import {Updater} from '../platform/ports/updater.port';
import {environment} from '../../environments/environment';

export interface UpdateInfo {
    version: string;
    currentVersion: string;
    body: string | null;
}

/**
 * How the last check ended.
 *
 * <p>`'unsupported'` is the host having no self-update at all - a web client updates by being reloaded.
 * It exists because the alternatives are both lies: `'up-to-date'` would claim a check happened and
 * found nothing, which is indistinguishable from success and would hide a stale client forever, and
 * `'error'` would claim a check happened and broke. Nothing is wrong; there is simply nothing to
 * check.</p>
 *
 * <p>Unlike `'up-to-date'` and `'error'` it does <b>not</b> decay back to `'idle'` after a few seconds,
 * because it is not news about an attempt - it is a standing fact about the host.</p>
 */
export type CheckStatus = 'idle' | 'up-to-date' | 'error' | 'unsupported';

@Injectable({providedIn: 'root'})
export class UpdateService {
    readonly dialogVisible = signal(false);
    readonly isChecking = signal(false);
    readonly isDownloading = signal(false);
    readonly downloadProgress = signal(0);
    readonly downloadedBytes = signal(0);
    readonly totalBytes = signal<number | null>(null);
    readonly updateInfo = signal<UpdateInfo | null>(null);
    readonly checkStatus = signal<CheckStatus>('idle');

    private readonly updater = inject(Updater);

    /**
     * Whether {@link checkForUpdates} found something the {@link Updater} is holding for us.
     *
     * <p>A boolean rather than the update itself: the plugin's `Update` object stays inside the Tauri
     * adapter, which is what let this service stop importing the plugin. {@link openDebugDialog}
     * deliberately does not set it, so the debug dialog can be shown without an install button that
     * would reach for an update nobody checked for.</p>
     */
    private pendingUpdate = false;
    private statusTimer: ReturnType<typeof setTimeout> | null = null;

    async checkForUpdates(force = false): Promise<void> {
        // Ahead of the production gate on purpose: whether this host can replace itself does not depend
        // on the build configuration, and `force` must not be able to conjure a check that cannot
        // happen. `force` is what the About page's button passes.
        //
        // The About page now hides its whole updater block on `PlatformCapabilities.selfUpdate`, so
        // nothing in the UI reaches this branch any more - the design spec's "hidden when its absence
        // needs no explanation". It stays because a caller that is not the About page still must not be
        // told a check succeeded when none happened.
        if (!this.updater.supported) {
            if (this.statusTimer) clearTimeout(this.statusTimer);
            this.statusTimer = null;
            this.checkStatus.set('unsupported');
            return;
        }

        if (!force && !environment.production) return;
        if (this.isChecking() || this.isDownloading() || this.dialogVisible()) return;

        if (this.statusTimer) clearTimeout(this.statusTimer);
        this.checkStatus.set('idle');
        this.isChecking.set(true);
        try {
            const update = await this.updater.check();
            if (update) {
                this.pendingUpdate = true;
                this.updateInfo.set({
                    version: update.version,
                    currentVersion: update.currentVersion,
                    body: update.body,
                });
                this.dialogVisible.set(true);
            } else {
                this.checkStatus.set('up-to-date');
                this.statusTimer = setTimeout(() => this.checkStatus.set('idle'), 4000);
            }
        } catch (error) {
            console.error('Update check failed:', error);
            this.checkStatus.set('error');
            this.statusTimer = setTimeout(() => this.checkStatus.set('idle'), 4000);
        } finally {
            this.isChecking.set(false);
        }
    }

    openDebugDialog(): void {
        this.updateInfo.set({
            version: '99.0.0',
            currentVersion: '0.1.0-alpha',
            body: '## What\'s New\n- Redesigned update dialog with progress tracking\n- Improved performance across the board\n- Fixed several crash issues on startup\n- New keyboard shortcut support',
        });
        this.dialogVisible.set(true);
    }

    async downloadAndInstall(): Promise<void> {
        if (!this.pendingUpdate || this.isDownloading()) return;

        this.isDownloading.set(true);
        this.downloadProgress.set(0);
        this.downloadedBytes.set(0);
        this.totalBytes.set(null);

        try {
            // The adapter accumulates chunk lengths and carries the content length across from the
            // plugin's separate `Started` event, so every callback here is a complete picture.
            await this.updater.downloadAndInstall(({downloaded, total}) => {
                this.downloadedBytes.set(downloaded);
                this.totalBytes.set(total);
                if (total) this.downloadProgress.set(Math.round((downloaded / total) * 100));
            });
        } catch (error) {
            console.error('Update installation failed:', error);
            this.isDownloading.set(false);
        }
    }

    close(): void {
        if (this.isDownloading()) return;
        this.dialogVisible.set(false);
        this.pendingUpdate = false;
        this.updateInfo.set(null);
    }
}
