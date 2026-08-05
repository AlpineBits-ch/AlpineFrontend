import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {catchError, debounceTime, of, Subject, switchMap} from 'rxjs';
import {AuthService} from './auth.service';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {isTauri} from '@tauri-apps/api/core';
import {disable, enable} from '@tauri-apps/plugin-autostart';

export interface NotificationSettings {
    enabled: boolean;
    dm: boolean;
    mentions: boolean;
    sounds: boolean;
    cooldownEnabled: boolean;
    cooldownSeconds: number;
}

/**
 * The client half of rich presence. The *privacy* half — whether activity is shared at all — is
 * `shareActivity` on the account's `UserPrivacySettings` and is enforced server-side; nothing here
 * is a privacy control.
 */
export interface ActivitySettings {
    /**
     * Games the user has individually opted out of, by detected name.
     *
     * <p><b>Keyed by name, not by application id, and that is a compromise.</b> The projection the
     * server filters on takes `hiddenApplicationIds`, but process-scan detection is the only source
     * shipping today and it resolves a name without an id. Keying on what we actually have means
     * the list works now; when RPC lands and ids arrive, entries gain ids and this becomes the
     * fallback for the id-less ones.</p>
     *
     * <p><b>TODO(backend):</b> this is enforced in {@link RichPresenceService} before the activity
     * is ever sent, which covers this device and no other. `UserPrivacySettings` is explicit
     * columns by design so a growing set wants its own table — until it exists, a second device
     * signed into the same account does not know about these opt-outs.</p>
     */
    hiddenGames: string[];

    /**
     * Whether to bind the local Discord RPC socket and accept presence from games built for
     * Discord's SDK.
     *
     * <p>Off by default and stays off until asked for: winning `discord-ipc-0` is first-come
     * first-served across the whole machine, so turning this on can stop Discord's own rich
     * presence from working. See the helper text on the settings row, which says so plainly.</p>
     */
    discordIntegration: boolean;
}

interface SettingsPayload {
    notifications: NotificationSettings;
    autostart: boolean;
    activity: ActivitySettings;
}

const DEFAULTS: SettingsPayload = {
    notifications: {enabled: true, dm: true, mentions: true, sounds: true, cooldownEnabled: true, cooldownSeconds: 10},
    autostart: false,
    activity: {hiddenGames: [], discordIntegration: false},
};

@Injectable({providedIn: 'root'})
export class UserSettingsService {
    private static readonly FOCUS_COOLDOWN_MS = 30_000;
    private authService = inject(AuthService);
    private _settings = signal<SettingsPayload>({
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
        void this.setupFocusSync();

        effect(() => {
            const enabled = this._settings().autostart;
            if (isTauri()) void (enabled ? enable() : disable()).catch(() => {
            });
        });

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

    private fetch(): void {
        this.lastFetch = Date.now();
        this.authService.getJsonSettings().pipe(
            catchError(() => of(null))
        ).subscribe(raw => {
            if (raw) this._settings.set(this.parse(raw));
        });
    }

    private async setupFocusSync(): Promise<void> {
        await getCurrentWindow().onFocusChanged(({payload: focused}) => {
            if (focused && Date.now() - this.lastFetch > UserSettingsService.FOCUS_COOLDOWN_MS) {
                this.fetch();
            }
        });
    }

    private parse(raw: unknown): SettingsPayload {
        const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, any>) : {};
        const n = obj['notifications'];
        const a = obj['activity'];
        return {
            activity: {
                // Filtered rather than trusted: this blob round-trips through an opaque server-side
                // JSON column, and a non-array here would make every `.includes` on it throw.
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
            },
            autostart: obj['autostart'] ?? DEFAULTS.autostart,
        };
    }
}
