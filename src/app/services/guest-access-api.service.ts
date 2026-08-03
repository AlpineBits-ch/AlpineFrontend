import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

/**
 * Time-boxed role grants.
 *
 * <p>Needs `ManageGuests` <b>and</b> the same role-hierarchy rule as ordinary role assignment: you
 * can only hand out a role you could have assigned by hand. That rule is enforced server-side and
 * surfaced the way {@link import('../features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component').RolesSettingsComponent}
 * already surfaces it - a `403` becomes the escalation message. There is no client-side hierarchy
 * check anywhere in this app to reuse, and inventing one here would only disagree with the server
 * about channel overwrites and role position ties.</p>
 *
 * <p>There is no list endpoint: temporary grants are read back off the normal role-members
 * listing, where they are the rows with a non-null `expiresAt`.</p>
 */
@Injectable({providedIn: 'root'})
export class GuestAccessApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private base(guildId: string, userId: string, roleId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/members/${userId}/roles/${roleId}/temporary`;
    }

    /**
     * Grants a role until `expiresAt`, or extends one already granted.
     *
     * @param expiresAt ISO instant, at most one year out. The grant lapses on its own at that
     *        moment - nobody has to remember to revoke it, and nothing on the server needs to run
     *        for it to stop working.
     */
    grant(guildId: string, userId: string, roleId: string, expiresAt: string): Observable<void> {
        return this.http.post<void>(this.base(guildId, userId, roleId), {expiresAt});
    }

    /** Ends a grant early, and is also how a lapsed row is tidied away by hand. */
    revoke(guildId: string, userId: string, roleId: string): Observable<void> {
        return this.http.delete<void>(this.base(guildId, userId, roleId));
    }
}
