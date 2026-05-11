import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from '@choochmeque/tauri-plugin-notifications-api';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { platform } from '@tauri-apps/plugin-os';
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

  private platformName: string | null = null;
  private readonly initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.init();

    this.action$.subscribe(async () => {
      const window = getCurrentWindow();
      await window.requestUserAttention(null);
    });
  }

  private async init(): Promise<void> {
    this.platformName = await platform();

    if (this.platformName === 'windows') {
      await listen<Record<string, string>>('notification-action', event => {
        this.action$.next({
          actionTypeId: event.payload['actionTypeId'] ?? 'message',
          extra: event.payload,
        });
      });
    } else {
      await this.setupActions();
    }
  }

  private async setupActions(): Promise<void> {
    try {
      await registerActionTypes([
        { id: 'message', actions: [{ id: 'open', title: 'Open' }] },
      ]);
    } catch {
      // notify-rust backend doesn't support action types
    }
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
    await this.initPromise;

    const ns = this.userSettings.notificationSettings();
    if (!ns.enabled) return;

    const category = params.category ?? 'system';
    if (category === 'dm' && !ns.dm) return;
    if (category === 'mention' && !ns.mentions) return;

    const actionTypeId = params.actionTypeId ?? 'message';
    const extra = params.extra ?? {};
    const playSound = ns.sounds && params.sound === NotificationSound.NewMessage;
    if (playSound) this.soundSettings.playMessage();

    if (this.platformName === 'windows') {
      await invoke('send_windows_toast', {
        title: params.title,
        body: params.message,
        iconUrl: params.profile?.avatarUrl ?? null,
        extra: { ...extra, actionTypeId },
      });
    } else {
      if (!await this.ensurePermission()) return;

      sendNotification({
        title: params.title,
        body: params.message,
        icon: params.profile?.avatarUrl,
        silent: true,
        actionTypeId,
        extra,
      });
    }
  }
}
