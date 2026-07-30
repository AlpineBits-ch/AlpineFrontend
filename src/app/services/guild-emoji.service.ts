import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {GuildEmojiDto} from '../dtos/response/guild-emoji.dto';

@Injectable({providedIn: 'root'})
export class GuildEmojiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);
    private base = this.apiConfig.baseUrl() + '/api/v1/guild';

    getEmojis(guildId: string): Observable<GuildEmojiDto[]> {
        return this.http.get<GuildEmojiDto[]>(`${this.base}/guilds/${guildId}/emojis`);
    }

    uploadEmoji(guildId: string, params: { name: string; animated: boolean; file: File }): Observable<GuildEmojiDto> {
        const fd = new FormData();
        fd.append('name', params.name);
        fd.append('animated', String(params.animated));
        fd.append('file', params.file);
        return this.http.post<GuildEmojiDto>(`${this.base}/guilds/${guildId}/emojis`, fd);
    }

    deleteEmoji(guildId: string, emojiId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/emojis/${emojiId}`);
    }
}
