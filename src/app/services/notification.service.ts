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
import { ToastService } from '../toast/toast.service';
import type { ProfileDto } from '../dtos/response/profile.dto';

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
  private toastService = inject(ToastService);

  readonly action$ = new Subject<NotificationActionEvent>();

  constructor() {
    if (this.isMobile()) void this.setupMobileActions();
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

    const actionTypeId = params.actionTypeId ?? 'message';
    const extra = params.extra ?? {};

    if (this.isMobile()) {
      if (!await this.ensurePermission()) return;
      sendNotification({
        title: params.title,
        body: params.message,
        actionTypeId,
        extra,
      });
    } else {
      this.toastService.show({
        title: params.title,
        body: params.message,
        avatarUrl: params.profile?.avatarUrl,
        avatarLabel: params.profile?.userName,
        sound: ns.sounds && params.sound === NotificationSound.NewMessage,
        onClick: () => this.action$.next({ actionTypeId, extra }),
      });
    }
  }
}
