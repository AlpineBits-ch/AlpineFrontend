import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {catchError, debounceTime, of, Subject, switchMap} from 'rxjs';
import {AuthService} from './auth.service';
import {Autostart} from '../platform/ports/autostart.port';

export interface NotificationSettings {
    enabled: boolean;
    dm: boolean;
    mentions: boolean;
    sounds: boolean;
    cooldownEnabled: boolean;
    cooldownSeconds: number;
    /**
     * Guilds the user has opted into "X is live" notifications for. An allow-list, not a mute-list,
     * so an untouched guild defaults to off. Says nothing about a friend streaming in it.
     */
    goLiveGuildIds: string[];

    /**
     * Whether a friend going live notifies. Defaults on, and stays independent of
     * `goLiveGuildIds`: turning this off must not touch that list, and a separately opted-in guild
     * still notifies with this off.
     */
    goLiveFriendsEnabled: boolean;
}

/**
 * The client half of rich presence. Nothing here is a privacy control: whether activity is shared
 * at all is `shareActivity` on `UserPrivacySettings`, enforced server-side.
 */
export interface ActivitySettings {
    /**
     * Games the user has individually opted out of, keyed by detected name rather than application
     * id: process-scan detection resolves a name without an id.
     *
     * TODO(backend): enforced in {@link RichPresenceService} before the activity is sent, so it
     * covers this device only. A second device signed into the same account does not know about it.
     */
    hiddenGames: string[];

    /**
     * Whether to bind the local Discord RPC socket. Off by default: `discord-ipc-0` is first-come
     * first-served machine-wide, so enabling it can stop Discord's own rich presence working.
     */
    discordIntegration: boolean;
}

interface SettingsPayload {
    notifications: NotificationSettings;
    autostart: boolean;
    activity: ActivitySettings;
}

/** What comes back out of the opaque server-side JSON column. Nothing here has been verified. */
interface RawSettings {
    notifications?: Partial<NotificationSettings>;
    activity?: Partial<ActivitySettings>;
    autostart?: boolean;
}

const DEFAULTS: SettingsPayload = {
    notifications: {
        enabled: true,
        dm: true,
        mentions: true,
        sounds: true,
        cooldownEnabled: true,
        cooldownSeconds: 10,
        goLiveGuildIds: [],
        goLiveFriendsEnabled: true,
    },
    autostart: false,
    activity: {hiddenGames: [], discordIntegration: false},
};

@Injectable({providedIn: 'root'})
export class UserSettingsService {
    private static readonly FOCUS_COOLDOWN_MS = 30_000;
    private authService = inject(AuthService);
    private readonly autostart = inject(Autostart);
    private readonly _settings = signal<SettingsPayload>({
        notifications: {...DEFAULTS.notifications},
        autostart: DEFAULTS.autostart,
        activity: {...DEFAULTS.activity, hiddenGames: []},
    });
    readonly notificationSettings = computed(() => this._settings().notifications);
    readonly autostartEnabled = computed(() => this._settings().autostart);
    readonly activitySettings = computed(() => this._settings().activity);
    private save$ = new Subject<void>();
    private lastFetch = 0;

    constructor() {
        this.fetch();
        this.setupFocusSync();

        // Must stay gated on `supported` rather than attempted and swallowed: `setEnabled` rejects
        // deliberately on a host that cannot register a launch entry, and catching that turns
        // "cannot" into "did", which is the dead-toggle bug class.
        effect(() => {
            const enabled = this._settings().autostart;
            if (!this.autostart.supported) return;
            void this.autostart
                .setEnabled(enabled)
                .catch(err => console.warn('[UserSettings] could not apply the autostart setting', err));
        });

        this.save$
            .pipe(
                debounceTime(600),
                switchMap(() =>
                    this.authService.updateJsonSettings(this._settings()).pipe(catchError(() => of(null))),
                ),
            )
            .subscribe();
    }

    /** Re-fetch settings from the server (call after login). */
    load(): void {
        this.fetch();
    }

    updateNotifications(patch: Partial<NotificationSettings>): void {
        this._settings.update(s => ({
            ...s,
            notifications: {...s.notifications, ...patch},
        }));
        this.save$.next();
    }

    updateAutostart(enabled: boolean): void {
        this._settings.update(s => ({...s, autostart: enabled}));
        this.save$.next();
    }

    updateActivity(patch: Partial<ActivitySettings>): void {
        this._settings.update(s => ({...s, activity: {...s.activity, ...patch}}));
        this.save$.next();
    }

    /** Adds or removes one game from the per-game opt-out list. */
    setGameHidden(name: string, hidden: boolean): void {
        const current = this._settings().activity.hiddenGames;
        const without = current.filter(g => g !== name);
        this.updateActivity({hiddenGames: hidden ? [...without, name] : without});
    }

    /** Opts a guild in or out of "X is live" notifications. See {@link NotificationSettings.goLiveGuildIds}. */
    setGoLiveNotifyEnabled(guildId: string, enabled: boolean): void {
        const current = this._settings().notifications.goLiveGuildIds;
        const without = current.filter(id => id !== guildId);
        this.updateNotifications({goLiveGuildIds: enabled ? [...without, guildId] : without});
    }

    /** Mutes or unmutes friend go-live notifications. See {@link NotificationSettings.goLiveFriendsEnabled}. */
    setGoLiveFriendsEnabled(enabled: boolean): void {
        this.updateNotifications({goLiveFriendsEnabled: enabled});
    }

    private fetch(): void {
        this.lastFetch = Date.now();
        this.authService
            .getJsonSettings()
            .pipe(catchError(() => of(null)))
            .subscribe(raw => {
                if (raw) this._settings.set(this.parse(raw));
            });
    }

    /**
     * Re-reads the settings blob when the user comes back to the app. DOM `focus` plus
     * `visibilitychange`, not a window focus event: `visibilitychange` is the one that carries a
     * backgrounded tab, which has no `focus` to lose. Never unsubscribed; this is a root singleton
     * and {@link FOCUS_COOLDOWN_MS} is what keeps a noisy source cheap.
     */
    private setupFocusSync(): void {
        if (typeof window === 'undefined') return;

        const onReturn = (): void => {
            if (Date.now() - this.lastFetch > UserSettingsService.FOCUS_COOLDOWN_MS) this.fetch();
        };

        window.addEventListener('focus', onReturn);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) onReturn();
        });
    }

    private parse(raw: unknown): SettingsPayload {
        const obj: RawSettings = typeof raw === 'object' && raw !== null ? (raw as RawSettings) : {};
        const n = obj['notifications'];
        const a = obj['activity'];
        return {
            activity: {
                // Must be filtered, not trusted: this round-trips through an opaque server-side JSON
                // column, and a non-array here makes every `.includes` on it throw.
                hiddenGames: Array.isArray(a?.hiddenGames)
                    ? a.hiddenGames.filter((g: unknown): g is string => typeof g === 'string')
                    : [],
                discordIntegration: a?.discordIntegration ?? DEFAULTS.activity.discordIntegration,
            },
            notifications: {
                enabled: n?.enabled ?? DEFAULTS.notifications.enabled,
                dm: n?.dm ?? DEFAULTS.notifications.dm,
                mentions: n?.mentions ?? DEFAULTS.notifications.mentions,
                sounds: n?.sounds ?? DEFAULTS.notifications.sounds,
                cooldownEnabled: n?.cooldownEnabled ?? DEFAULTS.notifications.cooldownEnabled,
                cooldownSeconds: n?.cooldownSeconds ?? DEFAULTS.notifications.cooldownSeconds,
                // Filtered, not trusted, like `hiddenGames` above: same opaque JSON column.
                goLiveGuildIds: Array.isArray(n?.goLiveGuildIds)
                    ? n.goLiveGuildIds.filter((id: unknown): id is string => typeof id === 'string')
                    : DEFAULTS.notifications.goLiveGuildIds,
                goLiveFriendsEnabled: n?.goLiveFriendsEnabled ?? DEFAULTS.notifications.goLiveFriendsEnabled,
            },
            autostart: obj['autostart'] ?? DEFAULTS.autostart,
        };
    }
}
