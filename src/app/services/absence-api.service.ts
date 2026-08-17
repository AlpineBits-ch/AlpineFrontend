import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {Absence, AbsenceSaved} from '../dtos/response/absence.dto';
import {CreateAbsenceDto, UpdateAbsenceDto} from '../dtos/request/absence.dto';

/**
 * The absence HTTP surface and nothing else, guild-scoped because an absence belongs to a member rather than to a board.
 * No write here carries a `userId`, and that is the contract: `POST` writes your own only, and `ManageGuild` may amend or withdraw somebody else's but never create one.
 */
@Injectable({providedIn: 'root'})
export class AbsenceApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /** Every member's absences overlapping the window. Any member may read them. */
    list(guildId: string, from?: string | null, to?: string | null): Observable<Absence[]> {
        let params = new HttpParams();
        if (from) params = params.set('from', from);
        if (to) params = params.set('to', to);
        return this.http.get<Absence[]>(`${this.base}/guilds/${guildId}/absences`, {params});
    }

    /**
     * Declares your own absence. Answers with `choresReassigned`, which must be shown: the write moves chores onto other people's boards.
     * A `400` on an overlap names the collision rather than merging, so surface that message rather than a generic failure.
     */
    create(guildId: string, body: CreateAbsenceDto): Observable<AbsenceSaved> {
        return this.http.post<AbsenceSaved>(`${this.base}/guilds/${guildId}/absences`, body);
    }

    /** Amends one. Yours, or anybody's with `ManageGuild`. Shortening does not claw the chores back, and the confirm copy has to say so. */
    update(absenceId: string, body: UpdateAbsenceDto): Observable<AbsenceSaved> {
        return this.http.patch<AbsenceSaved>(`${this.base}/absences/${absenceId}`, body);
    }

    /** Withdraws one. Same permissions, and the same "chores stay where they went" rule. */
    delete(absenceId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/absences/${absenceId}`);
    }
}
