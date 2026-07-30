import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {LoginSessionDto} from '../dtos/response/login-session.dto';

@Injectable({providedIn: 'root'})
export class LoginSessionsService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/sessions';
    }

    list(): Observable<LoginSessionDto[]> {
        return this.http.get<LoginSessionDto[]>(this.base);
    }

    /**
     * Stops the session from refreshing its access token. Its *current* access token keeps
     * working until it expires (up to ~an hour) -stateless tokens are not checked against
     * the session store, so revoke is not an instant kick.
     */
    revoke(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/${id}`);
    }
}
