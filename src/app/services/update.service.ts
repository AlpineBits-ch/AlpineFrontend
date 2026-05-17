import {Injectable, signal} from '@angular/core';
import {check, Update} from '@tauri-apps/plugin-updater';
import {relaunch} from '@tauri-apps/plugin-process';
import {environment} from '../../environments/environment';

export interface UpdateInfo {
    version: string;
    currentVersion: string;
    body: string | null;
}

export type CheckStatus = 'idle' | 'up-to-date' | 'error';

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

    private pendingUpdate: Update | null = null;
    private statusTimer: ReturnType<typeof setTimeout> | null = null;

    async checkForUpdates(force = false): Promise<void> {
        if (!force && !environment.production) return;
        if (this.isChecking() || this.isDownloading() || this.dialogVisible()) return;

        if (this.statusTimer) clearTimeout(this.statusTimer);
        this.checkStatus.set('idle');
        this.isChecking.set(true);
        try {
            const update = await check();
            if (update) {
                this.pendingUpdate = update;
                this.updateInfo.set({
                    version: update.version,
                    currentVersion: update.currentVersion,
                    body: update.body ?? null,
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

        let downloaded = 0;

        try {
            await this.pendingUpdate.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                    this.totalBytes.set(event.data.contentLength ?? null);
                } else if (event.event === 'Progress') {
                    downloaded += event.data.chunkLength;
                    this.downloadedBytes.set(downloaded);
                    const total = this.totalBytes();
                    if (total) {
                        this.downloadProgress.set(Math.round((downloaded / total) * 100));
                    }
                }
            });
            await relaunch();
        } catch (error) {
            console.error('Update installation failed:', error);
            this.isDownloading.set(false);
        }
    }

    close(): void {
        if (this.isDownloading()) return;
        this.dialogVisible.set(false);
        this.pendingUpdate = null;
        this.updateInfo.set(null);
    }
}
