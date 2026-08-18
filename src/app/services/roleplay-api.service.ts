import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {SceneDto, SceneListDto} from '../dtos/response/scene.dto';
import {DiceRollDto} from '../dtos/response/dice.dto';
import {
    AddSceneParticipantDto,
    AdvanceTurnDto,
    CreateSceneDto,
    SkipTurnDto,
    UpdateSceneDto,
} from '../dtos/request/scene.dto';
import {RollDiceDto} from '../dtos/request/dice.dto';

/** Scenes and dice, as one injectable seam. `app.config.ts` binds the implementation. */
@Injectable()
export abstract class RoleplayApi {
    /** The guild's scene board, newest activity first. Answers in an envelope, not a bare array. */
    abstract listScenes(guildId: string): Observable<SceneListDto>;

    abstract getScene(guildId: string, sceneChannelId: string): Observable<SceneDto>;

    abstract createScene(guildId: string, channelId: string, dto: CreateSceneDto): Observable<SceneDto>;

    abstract updateScene(guildId: string, sceneChannelId: string, dto: UpdateSceneDto): Observable<SceneDto>;

    abstract addParticipant(
        guildId: string,
        sceneChannelId: string,
        dto: AddSceneParticipantDto,
    ): Observable<SceneDto>;

    abstract removeParticipant(
        guildId: string,
        sceneChannelId: string,
        personaId: string,
    ): Observable<SceneDto>;

    /** Passing without posting. The turn advances on its own when the character posts. */
    abstract advanceTurn(guildId: string, sceneChannelId: string, dto: AdvanceTurnDto): Observable<SceneDto>;

    abstract skipTurn(guildId: string, sceneChannelId: string, dto: SkipTurnDto): Observable<SceneDto>;

    abstract roll(guildId: string, channelId: string, dto: RollDiceDto): Observable<DiceRollDto>;
}

@Injectable()
export class HttpRoleplayApi extends RoleplayApi {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    private scene(guildId: string, sceneChannelId: string): string {
        return `${this.base}/guilds/${guildId}/scenes/${sceneChannelId}`;
    }

    listScenes(guildId: string): Observable<SceneListDto> {
        return this.http.get<SceneListDto>(`${this.base}/guilds/${guildId}/scenes`);
    }

    getScene(guildId: string, sceneChannelId: string): Observable<SceneDto> {
        return this.http.get<SceneDto>(this.scene(guildId, sceneChannelId));
    }

    createScene(guildId: string, channelId: string, dto: CreateSceneDto): Observable<SceneDto> {
        return this.http.post<SceneDto>(`${this.base}/guilds/${guildId}/channels/${channelId}/scenes`, dto);
    }

    updateScene(guildId: string, sceneChannelId: string, dto: UpdateSceneDto): Observable<SceneDto> {
        return this.http.patch<SceneDto>(this.scene(guildId, sceneChannelId), dto);
    }

    addParticipant(
        guildId: string,
        sceneChannelId: string,
        dto: AddSceneParticipantDto,
    ): Observable<SceneDto> {
        return this.http.post<SceneDto>(`${this.scene(guildId, sceneChannelId)}/participants`, dto);
    }

    removeParticipant(guildId: string, sceneChannelId: string, personaId: string): Observable<SceneDto> {
        return this.http.delete<SceneDto>(`${this.scene(guildId, sceneChannelId)}/participants/${personaId}`);
    }

    advanceTurn(guildId: string, sceneChannelId: string, dto: AdvanceTurnDto): Observable<SceneDto> {
        return this.http.post<SceneDto>(`${this.scene(guildId, sceneChannelId)}/turn/advance`, dto);
    }

    skipTurn(guildId: string, sceneChannelId: string, dto: SkipTurnDto): Observable<SceneDto> {
        return this.http.post<SceneDto>(`${this.scene(guildId, sceneChannelId)}/turn/skip`, dto);
    }

    roll(guildId: string, channelId: string, dto: RollDiceDto): Observable<DiceRollDto> {
        return this.http.post<DiceRollDto>(`${this.base}/guilds/${guildId}/channels/${channelId}/rolls`, dto);
    }
}
