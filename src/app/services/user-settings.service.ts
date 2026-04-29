import { computed, inject, Injectable, signal } from '@angular/core';
import { catchError, debounceTime, of, Subject, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface NotificationSettings {
  enabled: boolean;
  dm: boolean;
  mentions: boolean;
  sounds: boolean;
}

interface SettingsPayload {
  notifications: NotificationSettings;
}

const DEFAULTS: SettingsPayload = {
  notifications: { enabled: true, dm: true, mentions: true, sounds: true },
};

@Injectable({ providedIn: 'root' })
export class UserSettingsService {
  private authService = inject(AuthService);

  private _settings = signal<SettingsPayload>({
    notifications: { ...DEFAULTS.notifications },
  });

  readonly notificationSettings = computed(() => this._settings().notifications);

  private save$ = new Subject<void>();
  private lastFetch = 0;
  private static readonly FOCUS_COOLDOWN_MS = 30_000;

  constructor() {
    this.fetch();
    void this.setupFocusSync();

    this.save$.pipe(
      debounceTime(600),
      switchMap(() =>
        this.authService.updateJsonSettings(this._settings()).pipe(
          catchError(() => of(null))
        )
      )
    ).subscribe();
  }

  /** Re-fetch settings from the server (call after login). */
  load(): void {
    this.fetch();
  }

  updateNotifications(patch: Partial<NotificationSettings>): void {
    this._settings.update(s => ({
      ...s,
      notifications: { ...s.notifications, ...patch },
    }));
    this.save$.next();
  }

  private fetch(): void {
    this.lastFetch = Date.now();
    this.authService.getJsonSettings().pipe(
      catchError(() => of(null))
    ).subscribe(raw => {
      if (raw) this._settings.set(this.parse(raw));
    });
  }

  private async setupFocusSync(): Promise<void> {
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused && Date.now() - this.lastFetch > UserSettingsService.FOCUS_COOLDOWN_MS) {
        this.fetch();
      }
    });
  }

  private parse(raw: unknown): SettingsPayload {
    const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, any>) : {};
    const n = obj['notifications'];
    return {
      notifications: {
        enabled: n?.enabled ?? DEFAULTS.notifications.enabled,
        dm: n?.dm ?? DEFAULTS.notifications.dm,
        mentions: n?.mentions ?? DEFAULTS.notifications.mentions,
        sounds: n?.sounds ?? DEFAULTS.notifications.sounds,
      },
    };
  }
}
