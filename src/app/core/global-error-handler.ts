import { ErrorHandler, Injectable } from '@angular/core';

const ERROR_WINDOW_MS = 5_000;
const ERROR_THRESHOLD = 3;

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly timestamps: number[] = [];
  private reloadScheduled = false;

  handleError(error: unknown): void {
    console.error('[App]', error);

    // HTTP/network errors are handled per-request — don't count them toward the crash threshold.
    if (this.isRoutineError(error)) return;

    const now = Date.now();
    while (this.timestamps.length && now - this.timestamps[0] > ERROR_WINDOW_MS) {
      this.timestamps.shift();
    }
    this.timestamps.push(now);

    if (this.timestamps.length >= ERROR_THRESHOLD && !this.reloadScheduled) {
      this.reloadScheduled = true;
      console.error('[App] Repeated errors — reloading in 3 s');
      setTimeout(() => window.location.reload(), 3_000);
    }
  }

  private isRoutineError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    // HttpErrorResponse has a numeric status field.
    return typeof (error as Record<string, unknown>)['status'] === 'number';
  }
}
