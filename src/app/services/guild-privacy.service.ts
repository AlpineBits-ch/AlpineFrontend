import {computed, inject, Injectable, signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, tap} from 'rxjs';
import {ApiConfigService} from './api-config.service';

export interface GuildDirectMessagePreference {
    guildId: string;
    allowDirectMessages: boolean;
}

/**
 * Per-guild direct message overrides (T2-14).
 *
 * <p>Only consulted when the account's global policy is `FriendsAndServerMembers`: a shared guild
 * admits a DM only if the recipient has not turned DMs off <i>for that guild</i>. Under
 * `Friends` or `Nobody` the global policy already refuses, and under `Everyone` there is nothing
 * for a per-guild rule to narrow - so the toggle is presented as the qualifier it is rather than
 * as an independent switch.</p>
 *
 * <p>Absence of an override means "follow the global policy", which is why the map holds only the
 * guilds that have one rather than an entry per guild the user is in.</p>
 */
@Injectable({providedIn: 'root'})
export class GuildPrivacyService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private readonly _overrides = signal<ReadonlyMap<string, boolean>>(new Map());
    private readonly _loaded = signal(false);

    readonly loaded = this._loaded.asReadonly();

    /** The effective value for a guild: its override, or the permissive default. */
    readonly allowsDirectMessages = computed(
        () =>
            (guildId: string): boolean =>
                this._overrides().get(guildId) ?? true,
    );

    load(): Observable<GuildDirectMessagePreference[]> {
        return this.http
            .get<GuildDirectMessagePreference[]>(
                `${this.apiConfig.baseUrl()}/api/v1/guild/users/me/guild-privacy`,
            )
            .pipe(
                tap(prefs => {
                    this._overrides.set(new Map(prefs.map(p => [p.guildId, p.allowDirectMessages])));
                    this._loaded.set(true);
                }),
            );
    }

    setAllowDirectMessages(guildId: string, allowDirectMessages: boolean): Observable<void> {
        return this.http
            .put<void>(`${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/privacy`, {
                allowDirectMessages,
            })
            .pipe(
                tap(() =>
                    this._overrides.update(map => {
                        const next = new Map(map);
                        next.set(guildId, allowDirectMessages);
                        return next;
                    }),
                ),
            );
    }

    reset(): void {
        this._overrides.set(new Map());
        this._loaded.set(false);
    }
}
