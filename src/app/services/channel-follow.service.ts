import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ChannelFollowDto, CreatedChannelFollowDto} from '../dtos/response/channel-follow.dto';

@Injectable({providedIn: 'root'})
export class ChannelFollowService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /** Initiated from the receiving side. 409 means that exact source-to-target pairing already exists. */
    follow(sourceChannelId: string, targetChannelId: string): Observable<CreatedChannelFollowDto> {
        return this.http.post<CreatedChannelFollowDto>(
            `${this.base}/channels/${sourceChannelId}/followers`, {targetChannelId});
    }

    /** Source-side admin view ("who is subscribed to us"): needs ManageChannel on the source. */
    listFollowers(sourceChannelId: string): Observable<ChannelFollowDto[]> {
        return this.http.get<ChannelFollowDto[]>(`${this.base}/channels/${sourceChannelId}/followers`);
    }

    /** Either side may unfollow: a manager of the target guild or of the source guild. */
    unfollow(sourceChannelId: string, followId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${sourceChannelId}/followers/${followId}`);
    }
}
