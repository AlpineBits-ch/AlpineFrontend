import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {QuietHoursDto} from '../dtos/response/quiet-hours.dto';

/**
 * Quiet hours over HTTP. There is no realtime event: the settings page reads it on open and that is
 * the whole lifecycle.
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
     * Writable with `ManageGuild`. `400` on a minute outside 0-1439, on `start === end`, or on an
     * unknown IANA id; all three are checked client-side by `validateQuietHours`.
     */
    put(guildId: string, config: QuietHoursDto): Observable<QuietHoursDto> {
        return this.http.put<QuietHoursDto>(this.base(guildId), config);
    }
}
