import {Component, computed, inject, OnDestroy, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {HttpErrorResponse} from '@angular/common/http';
import {FileSaver} from '../../../../../../platform/ports/file-saver.port';
import {
    canDownload,
    DATA_EXPORT_TERMINAL,
    DataExportDto,
    DataExportService,
    DataExportStatus,
    downloadErrorStatus,
} from '../../../../../../services/data-export.service';
import {ToastService} from '../../../../../../services/toast.service';
import {PlatformCapabilities} from '../../../../../../platform/capabilities';

/** How often an in-progress export is re-checked. The saga fans out across every service. */
const POLL_INTERVAL_MS = 5_000;

/** How long until another export may be requested, rounded up to whole hours. */
function retryAfterHours(err: HttpErrorResponse): number | null {
    const body = err.error as { retryAfterSeconds?: unknown } | null;
    const fromBody = body && typeof body === 'object' ? Number(body.retryAfterSeconds) : NaN;
    const seconds = Number.isFinite(fromBody) && fromBody > 0
        ? fromBody
        : Number(err.headers.get('Retry-After'));
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.max(1, Math.ceil(seconds / 3600));
}

/** Request, track and download a copy of the account's data (T1-7). */
@Component({
    selector: 'app-data-export',
    imports: [Button, DatePipe, TranslateModule],
    templateUrl: './data-export.component.html',
})
export class DataExportComponent implements OnInit, OnDestroy {
    private readonly exports = inject(DataExportService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly fileSaver = inject(FileSaver);

    protected readonly items = signal<DataExportDto[]>([]);
    protected readonly loading = signal(false);
    protected readonly requesting = signal(false);
    protected readonly downloading = signal<string | null>(null);
    protected readonly unavailable = signal(false);

    /** Whether the artifact can be fetched at all on this host. */
    protected readonly downloadBlocked = inject(PlatformCapabilities).host === 'web';

    /** An export already in flight; the request button stays disabled while one exists. */
    protected readonly inFlight = computed(() =>
        this.items().some(e => !DATA_EXPORT_TERMINAL.includes(e.status)),
    );

    private pollHandle: ReturnType<typeof setInterval> | null = null;

    ngOnInit(): void {
        this.refresh();
    }

    ngOnDestroy(): void {
        this.stopPolling();
    }

    protected refresh(): void {
        this.loading.set(true);
        this.exports.list().subscribe({
            next: items => {
                this.items.set(items);
                this.loading.set(false);
                this.unavailable.set(false);
                this.syncPolling();
            },
            error: () => {
                this.loading.set(false);
                this.unavailable.set(true);
                this.stopPolling();
            },
        });
    }

    protected request(): void {
        if (this.inFlight() || this.requesting()) return;
        this.requesting.set(true);

        this.exports.request().subscribe({
            next: created => {
                this.items.update(list => [created, ...list]);
                this.requesting.set(false);
                this.toast.success(this.translate.instant('SETTINGS.PRIVACY.EXPORT_REQUESTED'));
                this.syncPolling();
            },
            error: (err: HttpErrorResponse) => {
                this.requesting.set(false);
                // 429 here is the one-per-24h export limit, not the gateway's request bucket, so
                // it is a normal answer rather than a fault - and it carries how long to wait.
                if (err.status === 429) {
                    const hours = retryAfterHours(err);
                    this.toast.error(this.translate.instant(
                        hours === null
                            ? 'SETTINGS.PRIVACY.EXPORT_RATE_LIMITED'
                            : 'SETTINGS.PRIVACY.EXPORT_RATE_LIMITED_IN',
                        {hours},
                    ));
                    return;
                }
                this.toast.error(this.translate.instant('SETTINGS.PRIVACY.EXPORT_REQUEST_ERROR'));
            },
        });
    }

    protected download(item: DataExportDto): void {
        if (this.downloading()) return;
        this.downloading.set(item.exportId);

        // The desktop shell writes the artifact to disk itself; the webview cannot fetch it, since
        // the signed storage URL the endpoint redirects to is not CORS-enabled. See
        // DataExportService.saveToDisk.
        if (this.exports.canSaveToDisk) {
            void this.saveToDisk(item);
            return;
        }

        this.exports.download(item.exportId).subscribe({
            next: blob => {
                // Handing a blob to the host can itself fail - the mobile shell takes this path and
                // writes a real file - so the rejection is caught rather than left floating.
                this.saveBlob(blob, this.filename(item))
                    .catch(err => this.reportDownloadError(err))
                    .finally(() => this.downloading.set(null));
            },
            error: (err: HttpErrorResponse) => {
                this.downloading.set(null);
                this.reportDownloadError(err);
            },
        });
    }

    private async saveToDisk(item: DataExportDto): Promise<void> {
        try {
            // The picker lives inside the service, next to the native download it feeds: the chosen
            // path has to reach Rust, and a path is the one thing FileSaver deliberately never hands
            // back. It is still asked for before the transfer starts - an export runs to whatever the
            // account weighs, and a cancelled save should not have cost the user that download first.
            const saved = await this.exports.saveToDiskWithPicker(item.exportId, this.filename(item));
            if (!saved) return;

            this.toast.success(this.translate.instant('SETTINGS.PRIVACY.EXPORT_SAVED'));
        } catch (err) {
            this.reportDownloadError(err);
        } finally {
            this.downloading.set(null);
        }
    }

    /**
     * 409 and 410 are answers about the export, not transport failures: the artifact was never
     * built, or it has already been deleted. Both need a different next step from "try again", so
     * neither is folded into the generic message. The list is re-read because a 410 means the local
     * copy's status is stale.
     */
    private reportDownloadError(err: unknown): void {
        const status = downloadErrorStatus(err);
        if (status === 410) {
            this.toast.error(this.translate.instant('SETTINGS.PRIVACY.EXPORT_EXPIRED_ERROR'));
            this.refresh();
            return;
        }
        if (status === 409) {
            this.toast.error(this.translate.instant('SETTINGS.PRIVACY.EXPORT_FAILED_ERROR'));
            this.refresh();
            return;
        }
        this.toast.error(this.translate.instant('SETTINGS.PRIVACY.EXPORT_DOWNLOAD_ERROR'));
    }

    private filename(item: DataExportDto): string {
        return `echo-data-export-${item.exportId}.zip`;
    }

    protected statusKey(status: DataExportStatus): string {
        return `SETTINGS.PRIVACY.EXPORT_STATUS_${status.toUpperCase()}`;
    }

    protected isDownloadable(status: DataExportStatus): boolean {
        return canDownload(status);
    }

    /** The non-desktop path: the archive is already a `Blob` in memory, so hand it to the host to save. */
    private async saveBlob(blob: Blob, filename: string): Promise<void> {
        await this.fileSaver.save(
            filename,
            new Uint8Array(await blob.arrayBuffer()),
            blob.type || 'application/zip',
        );
    }

    private syncPolling(): void {
        if (this.inFlight()) this.startPolling(); else this.stopPolling();
    }

    private startPolling(): void {
        if (this.pollHandle !== null) return;
        this.pollHandle = setInterval(() => {
            this.exports.list().subscribe({
                next: items => {
                    this.items.set(items);
                    this.syncPolling();
                },
                error: () => this.stopPolling(),
            });
        }, POLL_INTERVAL_MS);
    }

    private stopPolling(): void {
        if (this.pollHandle === null) return;
        clearInterval(this.pollHandle);
        this.pollHandle = null;
    }
}
