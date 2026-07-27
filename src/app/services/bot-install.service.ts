import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ManageableGuildDto, BotAuthorizeInfoDto, BotInstallResultDto} from '../dtos/response/bot-install.dto';
import {AuthorizeBotDto} from '../dtos/request/authorize-bot.dto';

@Injectable({providedIn: 'root'})
export class BotInstallService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/bots`;
    }

    getManageableGuilds(clientId: string): Observable<ManageableGuildDto[]> {
        return this.http.get<ManageableGuildDto[]>(`${this.base()}/guilds/manageable`, {
            params: {clientId},
        });
    }

    getAuthorizeInfo(clientId: string, permissions: bigint, guildId: string): Observable<BotAuthorizeInfoDto> {
        return this.http.get<BotAuthorizeInfoDto>(`${this.base()}/oauth2/authorize`, {
            params: {clientId, permissions: permissions.toString(), guildId},
        });
    }

    authorize(dto: AuthorizeBotDto): Observable<BotInstallResultDto> {
        return this.http.post<BotInstallResultDto>(`${this.base()}/oauth2/authorize`, dto);
    }
}
