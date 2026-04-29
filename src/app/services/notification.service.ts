import { inject, Injectable } from '@angular/core';
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { Subject } from 'rxjs';
import { UserSettingsService } from './user-settings.service';
import {getCurrentWindow, UserAttentionType} from "@tauri-apps/api/window";

export enum NotificationSound {
  None,
  NewMessage
}

export type NotificationCategory = 'dm' | 'mention' | 'system';

export interface NotificationActionEvent {
  actionTypeId: string;
  extra: Record<string, string>;
}

@Injectable({
  providedIn: 'root',
})
export class NotificationService {
  private userSettings = inject(UserSettingsService);

  /** Emits when the user interacts with a notification action. */
  readonly action$ = new Subject<NotificationActionEvent>();

  constructor() {
    void this.setup();
  }

  private async setup(): Promise<void> {
    await registerActionTypes([
      {
        id: 'message',
        actions: [{ id: 'open', title: 'Open' }],
      },
    ]);

    await onAction(async notification => {
      await invoke('focus_window');
      this.action$.next({
        actionTypeId: notification.actionTypeId ?? 'message',
        extra: (notification.extra ?? {}) as Record<string, string>,
      });
    });
  }

  private async getPermission(): Promise<void> {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }
  }

  public async createNotification(params: {
    message: string;
    title: string;
    icon: string | undefined;
    sound: NotificationSound;
    category?: NotificationCategory;
    actionTypeId?: string;
    extra?: Record<string, string>;
  }): Promise<void> {
    const ns = this.userSettings.notificationSettings();

    if (!ns.enabled) return;

    const windows = getCurrentWindow();
    await windows.requestUserAttention(UserAttentionType.Critical);
    const category = params.category ?? 'system';
    if (category === 'dm' && !ns.dm) return;
    if (category === 'mention' && !ns.mentions) return;

    await this.getPermission();
    sendNotification({
      title: params.title,
      body: params.message,
      icon: params.icon,
      actionTypeId: params.actionTypeId,
      extra: params.extra,

    });

    if (ns.sounds) {
      this.playSoundNotification(params.sound);
    }
  }

  private playSoundNotification(sound: NotificationSound): void {
    if (sound === NotificationSound.NewMessage) {
      const audio = new Audio('/assets/sounds/new_message.wav');
      audio.play().then();
    }
  }
}
