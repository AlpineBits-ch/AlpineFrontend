import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AppReadyService {
  private readonly _ready = signal(false);
  readonly ready = this._ready.asReadonly();

  markReady(): void {
    if (this._ready()) return;
    this._ready.set(true);
    const overlay = document.getElementById('app-loading');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 500);
  }
}
