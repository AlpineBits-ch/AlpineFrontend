import {inject, Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {
    isPermissionGranted,
    onAction,
    registerActionTypes,
    requestPermission,
    sendNotification,
} from '@choochmeque/tauri-plugin-notifications-api';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {platform} from '@tauri-apps/plugin-os';
import {UserSettingsService} from './user-settings.service';
import {SoundSettingsService} from './sound-settings.service';
import type {ProfileDto} from '../dtos/response/profile.dto';
import {getCurrentWindow} from "@tauri-apps/api/window";

export enum NotificationSound {
    None,
    NewMessage,
}

export type NotificationCategory = 'dm' | 'mention' | 'system';

export interface NotificationActionEvent {
    actionTypeId: string;
    extra: Record<string, string>;
}

@Injectable({providedIn: 'root'})
export class NotificationService {
    readonly action$ = new Subject<NotificationActionEvent>();
    private userSettings = inject(UserSettingsService);
    private soundSettings = inject(SoundSettingsService);
    private platformName: string | null = null;
    private readonly initPromise: Promise<void>;
    private lastNotificationTime = 0;

    constructor() {
        this.initPromise = this.init();

        this.action$.subscribe(async () => {
            const window = getCurrentWindow();
            await window.requestUserAttention(null);
        });
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
        // All filtering runs synchronously before any await so there are no yield-point race conditions.
        const ns = this.userSettings.notificationSettings();
        if (!ns.enabled) return;

        const category = params.category ?? 'system';
        if (category === 'dm' && !ns.dm) return;
        if (category === 'mention' && !ns.mentions) return;

        // Sound plays on every notification that passes the category filter, even during cooldown.
        if (ns.sounds && params.sound === NotificationSound.NewMessage) {
            this.soundSettings.playMessage();
        }

        // Cooldown only suppresses the OS notification popup, not the sound.
        if (ns.cooldownEnabled) {
            const now = Date.now();
            if (now - this.lastNotificationTime < ns.cooldownSeconds * 1000) return;
            this.lastNotificationTime = now;
        }

        await this.initPromise;

        const actionTypeId = params.actionTypeId ?? 'message';
        const extra = params.extra ?? {};

        if (this.platformName === 'windows') {
            await invoke('send_windows_toast', {
                title: params.title,
                body: params.message,
                iconUrl: params.profile?.avatarUrl ?? null,
                extra: {...extra, actionTypeId},
            });
        } else {
            if (!await this.ensurePermission()) return;

            // macOS native backend requires a local file:// URI — download avatar to temp first
            let icon: string | undefined = params.profile?.avatarUrl;
            if (this.platformName === 'macos' && icon) {
                const local = await invoke<string | null>('prepare_notification_icon', {url: icon}).catch(() => null);
                icon = local ?? icon;
            }

            sendNotification({
                title: params.title,
                body: params.message,
                icon,
                silent: true,
                actionTypeId,
                extra,
            });
        }
    }

    private async init(): Promise<void> {
        this.platformName = await platform();

        if (this.platformName === 'windows') {
            // Windows: native WinRT toasts handle activation in Rust, emit this event on click
            await listen<Record<string, string>>('notification-action', event => {
                this.action$.next({
                    actionTypeId: event.payload['actionTypeId'] ?? 'message',
                    extra: event.payload,
                });
            });
        } else {
            // macOS (native UNUserNotificationCenter) and mobile: action types are fully supported
            // Linux (notify-rust): registerActionTypes fails silently, onAction may not fire
            await this.setupActions();
        }
    }

    private async setupActions(): Promise<void> {
        try {
            await registerActionTypes([
                {id: 'message', actions: [{id: 'open', title: 'Open'}]},
            ]);
        } catch {
            // notify-rust (Linux) doesn't support action types
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
}
