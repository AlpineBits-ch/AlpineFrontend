import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {QuietHoursDto} from '../dtos/response/quiet-hours.dto';

/**
 * Quiet hours over HTTP. No realtime event exists for this - it is one row per guild, changed
 * rarely and by an admin, so the settings page reads it when it opens and that is the whole
 * lifecycle. Nothing caches it, because nothing else in the app needs it live.
 */
@Injectable({providedIn: 'root'})
export class QuietHoursApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private base(guildId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guildId}/quiet-hours`;
    }

    /** Readable by any member. */
    get(guildId: string): Observable<QuietHoursDto> {
        return this.http.get<QuietHoursDto>(this.base(guildId));
    }

    /**
     * Writable with `ManageGuild`.
     *
     * <p>`400` on a minute outside 0-1439, on `start === end`, or on an IANA id the server does not
     * know - all three are checked client-side first by `validateQuietHours`.</p>
     */
    put(guildId: string, config: QuietHoursDto): Observable<QuietHoursDto> {
        return this.http.put<QuietHoursDto>(this.base(guildId), config);
    }
}
