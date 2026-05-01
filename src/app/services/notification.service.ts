import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { UserSettingsService } from './user-settings.service';
import { SoundSettingsService } from './sound-settings.service';
import type { ProfileDto } from '../dtos/response/profile.dto';
import { getCurrentWindow } from "@tauri-apps/api/window";

export enum NotificationSound {
  None,
  NewMessage,
}

export type NotificationCategory = 'dm' | 'mention' | 'system';

export interface NotificationActionEvent {
  actionTypeId: string;
  extra: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private userSettings = inject(UserSettingsService);
  private soundSettings = inject(SoundSettingsService);

  readonly action$ = new Subject<NotificationActionEvent>();

  constructor() {
    if (this.isMobile()) void this.setupMobileActions();

    this.action$.subscribe(async () => {
      const window = getCurrentWindow();
      await window.requestUserAttention(null);
    });
  }

  private isMobile(): boolean {
    return typeof navigator !== 'undefined' &&
      /android|iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
  }

  private async setupMobileActions(): Promise<void> {
    await registerActionTypes([
      { id: 'message', actions: [{ id: 'open', title: 'Open' }] },
    ]);
    await onAction(notification => {
      this.action$.next({
        actionTypeId: notification.actionTypeId ?? 'message',
        extra: (notification.extra ?? {}) as Record<string, string>,
      });
    });
  }

  private async ensurePermission(): Promise<boolean> {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    return granted;
  }

  async createNotification(params: {
    message: string;
    title: string;
    profile?: ProfileDto;
    sound: NotificationSound;
    category?: NotificationCategory;
    actionTypeId?: string;
    extra?: Record<string, string>;
  }): Promise<void> {
    const ns = this.userSettings.notificationSettings();
    if (!ns.enabled) return;

    const category = params.category ?? 'system';
    if (category === 'dm' && !ns.dm) return;
    if (category === 'mention' && !ns.mentions) return;

    if (!await this.ensurePermission()) return;

    const actionTypeId = params.actionTypeId ?? 'message';
    const extra = params.extra ?? {};
    const playSound = ns.sounds && params.sound === NotificationSound.NewMessage;
    if (playSound) this.soundSettings.playMessage();

    sendNotification({
      title: params.title,
      body: params.message,
      silent: true,
      actionTypeId,
      extra,
    });
  }
}
