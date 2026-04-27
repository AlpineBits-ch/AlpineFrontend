import { Injectable } from '@angular/core';
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Subject } from 'rxjs';

export enum NotificationSound {
  None,
  NewMessage
}

export interface NotificationActionEvent {
  actionTypeId: string;
  extra: Record<string, string>;
}

@Injectable({
  providedIn: 'root',
})
export class NotificationService {
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
      await getCurrentWindow().setFocus();
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
    actionTypeId?: string;
    extra?: Record<string, string>;
  }): Promise<void> {
    await this.getPermission();
    sendNotification({
      title: params.title,
      body: params.message,
      icon: params.icon,
      actionTypeId: params.actionTypeId,
      extra: params.extra,
    });
    this.playSoundNotification(params.sound);
  }

  private playSoundNotification(sound: NotificationSound): void {
    if (sound === NotificationSound.NewMessage) {
      const audio = new Audio('/assets/sounds/new_message.wav');
      audio.play().then();
    }
  }
}
