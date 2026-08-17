import {ErrorHandler, Injectable} from '@angular/core';

const ERROR_WINDOW_MS = 5_000;
const ERROR_THRESHOLD = 3;
const MIN_RELOAD_INTERVAL_MS = 60_000;
const LAST_RELOAD_KEY = 'app_last_error_reload';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
    private readonly timestamps: number[] = [];
    private reloadScheduled = false;

    handleError(error: unknown): void {
        console.error('[App]', error);

        // HTTP/network errors are handled per-request; don't count them toward the crash threshold.
        if (this.isRoutineError(error)) return;

        const now = Date.now();
        while (this.timestamps.length && now - this.timestamps[0] > ERROR_WINDOW_MS) {
            this.timestamps.shift();
        }
        this.timestamps.push(now);

        if (this.timestamps.length >= ERROR_THRESHOLD && !this.reloadScheduled) {
            // Guard against reload loops: if we already reloaded within the last minute,
            // don't reload again. sessionStorage survives reloads within the same tab session.
            const lastReload = Number(sessionStorage.getItem(LAST_RELOAD_KEY) ?? 0);
            if (now - lastReload < MIN_RELOAD_INTERVAL_MS) {
                console.error('[App] Suppressing reload: reloaded too recently');
                return;
            }
            this.reloadScheduled = true;
            sessionStorage.setItem(LAST_RELOAD_KEY, String(now));
            console.error('[App] Repeated errors, reloading in 3 s');
            setTimeout(() => window.location.reload(), 3_000);
        }
    }

    private isRoutineError(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        // HttpErrorResponse has a numeric status field.
        return typeof (error as Record<string, unknown>)['status'] === 'number';
    }
}
