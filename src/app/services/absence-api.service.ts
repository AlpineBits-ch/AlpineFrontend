import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {Absence, AbsenceSaved} from '../dtos/response/absence.dto';
import {CreateAbsenceDto, UpdateAbsenceDto} from '../dtos/request/absence.dto';

/**
 * The absence HTTP surface, and nothing else.
 *
 * <p>Guild-scoped rather than channel-scoped, because an absence belongs to a member and to the
 * chore rota rather than to any one board.</p>
 *
 * <p><b>There is no `userId` on any write here, and that is the contract.</b> `POST` writes your own
 * only; `ManageGuild` can amend or withdraw somebody else's but cannot create one. Inventing an
 * absence for a flatmate would move their chores off them without their knowing.</p>
 */
@Injectable({providedIn: 'root'})
export class AbsenceApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /**
     * Every member's absences overlapping the window. Any member may read them - who is away is a
     * fact about the house, and the rota already acts on it.
     */
    list(guildId: string, from?: string | null, to?: string | null): Observable<Absence[]> {
        let params = new HttpParams();
        if (from) params = params.set('from', from);
        if (to) params = params.set('to', to);
        return this.http.get<Absence[]>(`${this.base}/guilds/${guildId}/absences`, {params});
    }

    /**
     * Declares your own absence.
     *
     * <p>Answers with `choresReassigned`: the write hands your unfinished chores in that window to
     * the lightest-loaded other flatmate. Say so - it is a consequence on other people's boards, and
     * the point of reporting it is that the member can check it before they get on the plane.</p>
     *
     * <p>`400` on an overlap with one of your own, <b>naming the collision</b> rather than merging.
     * Surface that message; a generic failure next to two valid-looking dates explains nothing.</p>
     */
    create(guildId: string, body: CreateAbsenceDto): Observable<AbsenceSaved> {
        return this.http.post<AbsenceSaved>(`${this.base}/guilds/${guildId}/absences`, body);
    }

    /**
     * Amends one. Yours, or anybody's with `ManageGuild`.
     *
     * <p><b>Shortening does not claw the chores back.</b> They went to somebody who has since planned
     * around having them, so the confirm copy has to say so - everyone expects the opposite.</p>
     */
    update(absenceId: string, body: UpdateAbsenceDto): Observable<AbsenceSaved> {
        return this.http.patch<AbsenceSaved>(`${this.base}/absences/${absenceId}`, body);
    }

    /** Withdraws one. Same permissions, and the same "chores stay where they went" rule. */
    delete(absenceId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/absences/${absenceId}`);
    }
}
