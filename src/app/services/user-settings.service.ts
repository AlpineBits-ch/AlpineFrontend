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
    private readonly autostart = inject(Autostart);
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
        this.setupFocusSync();

        // Gated on `supported`, not attempted-and-swallowed. The old `.catch(() => {})` was only
        // harmless because of the `isTauri()` guard in front of it: on a host that cannot register a
        // launch entry, `setEnabled` rejects deliberately, and catching that would turn "cannot" into
        // "did" - the dead-toggle bug class the capability rules exist to prevent.
        effect(() => {
            const enabled = this._settings().autostart;
            if (!this.autostart.supported) return;
            void this.autostart.setEnabled(enabled).catch(err =>
                console.warn('[UserSettings] could not apply the autostart setting', err));
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

    /**
     * Re-reads the settings blob when the user comes back to the app.
     *
     * <p><b>DOM events rather than the window's own focus event, on both hosts.</b> This used to be
     * Tauri's `onFocusChanged`, which is not on the `WindowChrome` port - and it should not be, because
     * this does not want to know about a window. It wants to know "has the user been away long enough
     * that another device may have changed something", and `focus` plus `visibilitychange` answer that
     * identically inside the Tauri webview and in a tab. `visibilitychange` is the one that carries a
     * backgrounded tab, which has no `focus` to lose.</p>
     *
     * <p>Never unsubscribed, deliberately: this is a root singleton for the life of the process, and a
     * teardown path that only ever runs at unload is a liability rather than hygiene. The
     * {@link FOCUS_COOLDOWN_MS} throttle is what keeps a noisy source cheap.</p>
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
