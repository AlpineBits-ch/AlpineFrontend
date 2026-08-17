import {inject, Injectable, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {UserSettingsService} from './user-settings.service';
import {SoundSettingsService} from './sound-settings.service';
import type {ProfileDto} from '../dtos/response/profile.dto';
import {PlatformCapabilities} from '../platform/capabilities';
import {Notifier} from '../platform/ports/notifier.port';
import {decodeNotificationTag, encodeNotificationTag} from '../platform/notification-tag';

export enum NotificationSound {
    None,
    NewMessage,
}

export type NotificationCategory = 'dm' | 'mention' | 'system';

export interface NotificationActionEvent {
    actionTypeId: string;
    extra: Record<string, string>;
}

/**
 * The app's notification policy: which events deserve a toast, which deserve a sound, and how often.
 *
 * <p>Everything host-specific moved behind the {@link Notifier} port - the three OS toast backends, the
 * WinRT path, the avatar file:// copy, the activation plumbing. What is left here is the part that is
 * the same on every host and that no adapter should be making decisions about: the user's category
 * filters, the sound, and the cooldown.</p>
 */
@Injectable({providedIn: 'root'})
export class NotificationService {
    readonly action$ = new Subject<NotificationActionEvent>();
    private userSettings = inject(UserSettingsService);
    private soundSettings = inject(SoundSettingsService);
    private notifier = inject(Notifier);
    private capabilities = inject(PlatformCapabilities);
    private readonly initPromise: Promise<void>;
    private lastNotificationTime = 0;
    private readonly blocked = signal(false);

    /**
     * Whether the host has refused to show notifications, durably.
     *
     * <p><b>Exists so no screen can claim notifications are on while nothing is being shown.</b> In a
     * browser a denied permission cannot be re-requested by the app - only the user, in browser
     * settings, can undo it - so the notification settings toggle can read `enabled` as true, look
     * entirely correct, and deliver nothing. That is the failure this flag names.</p>
     *
     * <p>Only latched on hosts without native toasts, from `PlatformCapabilities.nativeToasts`. A
     * desktop refusal is not durable in the same way: the user can grant notifications in OS settings
     * without the app ever seeing it, so the next attempt has to ask again rather than assume.</p>
     *
     * <p><b>Nothing reads this yet.</b> The notification settings page belongs to another track; the
     * flag is here because the service is the only thing that can know it.</p>
     */
    readonly notificationsBlocked = this.blocked.asReadonly();

    constructor() {
        this.initPromise = this.init();
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

        // Awaited so the activation subscription is in place before the first notification can be
        // clicked - and, on macOS, so the action type is registered before one is sent under it.
        await this.initPromise;

        if (!await this.ensurePermission()) return;

        await this.notifier.notify({
            title: params.title,
            body: params.message,
            iconUrl: params.profile?.avatarUrl,
            // The routing payload travels as the tag, which is the only thing both hosts carry back
            // through an activation. `main-page.component.ts` reads it off `action$` unchanged.
            tag: encodeNotificationTag({
                actionTypeId: params.actionTypeId ?? 'message',
                extra: params.extra ?? {},
            }),
        });
    }

    private async init(): Promise<void> {
        try {
            await this.notifier.onActivated(tag => this.action$.next(decodeNotificationTag(tag)));
        } catch (error) {
            // A host that cannot report activations still shows notifications. Rethrowing would leave
            // `initPromise` rejected and take every later `createNotification` down with it, trading
            // "clicks do not route" for "no notifications at all".
            console.error('Failed to subscribe to notification activations:', error);
        }
    }

    /**
     * Asks the host for permission, at most as often as it is worth asking.
     *
     * <p>Every host is asked, including the ones that have nothing to grant - the Tauri adapter answers
     * true immediately on Windows, where the WinRT toast path has no plugin permission. That keeps the
     * decision in one place instead of restoring a per-OS branch on this side of the port.</p>
     */
    private async ensurePermission(): Promise<boolean> {
        if (this.blocked()) return false;

        const granted = await this.notifier.requestPermission();
        if (!granted && !this.capabilities.nativeToasts) {
            // See `notificationsBlocked`: a browser will not re-prompt, so asking again per message
            // is a no-op that costs an await and hides the state from the UI.
            this.blocked.set(true);
        }

        return granted;
    }
}
