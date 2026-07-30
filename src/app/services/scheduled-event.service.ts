import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    CreateScheduledEventDto,
    ScheduledEventDto,
    UpdateScheduledEventDto,
} from '../dtos/response/scheduled-event.dto';

@Injectable({providedIn: 'root'})
export class ScheduledEventService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /** Already sorted by startsAt server-side. Cancelled events are excluded entirely. */
    list(guildId: string): Observable<ScheduledEventDto[]> {
        return this.http.get<ScheduledEventDto[]>(`${this.base}/guilds/${guildId}/events`);
    }

    create(guildId: string, dto: CreateScheduledEventDto): Observable<ScheduledEventDto> {
        return this.http.post<ScheduledEventDto>(`${this.base}/guilds/${guildId}/events`, dto);
    }

    update(eventId: string, dto: UpdateScheduledEventDto): Observable<ScheduledEventDto> {
        return this.http.patch<ScheduledEventDto>(`${this.base}/events/${eventId}`, dto);
    }

    /** Soft-cancels. The row survives so members who RSVP'd can see it was called off. */
    cancel(eventId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/events/${eventId}`);
    }

    markInterested(eventId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/events/${eventId}/interested`, {});
    }

    removeInterest(eventId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/events/${eventId}/interested`);
    }
}
