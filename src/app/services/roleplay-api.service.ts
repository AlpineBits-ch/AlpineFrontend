import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    SceneDto,
    SceneFolderDto,
    SceneListDto,
    SceneTagDto,
    SceneTaxonomyDto,
} from '../dtos/response/scene.dto';
import {DiceRollDto} from '../dtos/response/dice.dto';
import {
    AddSceneParticipantDto,
    AdvanceTurnDto,
    CreateSceneDto,
    CreateSceneFolderDto,
    CreateSceneTagDto,
    ReorderSceneFoldersDto,
    SceneListParams,
    SetSceneTagsDto,
    SkipTurnDto,
    UpdateSceneDto,
    UpdateSceneFolderDto,
    UpdateSceneTagDto,
} from '../dtos/request/scene.dto';
import {RollDiceDto} from '../dtos/request/dice.dto';

/** An absent value is left off the wire entirely, so the server's own default applies. */
function sceneListParams(params?: SceneListParams): HttpParams {
    let query = new HttpParams();
    if (!params) return query;

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            query = query.set(key, value.join(','));
            continue;
        }
        query = query.set(key, String(value));
    }
    return query;
}

/** Scenes and dice, as one injectable seam. `app.config.ts` binds the implementation. */
@Injectable()
export abstract class RoleplayApi {
    /** The guild's scene board, newest activity first. Answers in an envelope, not a bare array. */
    abstract listScenes(guildId: string, params?: SceneListParams): Observable<SceneListDto>;

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

    /** Chases whoever is on the clock. Answers no scene: the nudge arrives back over the hub. */
    abstract nudgeTurn(guildId: string, sceneChannelId: string): Observable<void>;

    abstract roll(guildId: string, channelId: string, dto: RollDiceDto): Observable<DiceRollDto>;

    // ── Archive taxonomy ────────────────────────────────────────────────────

    /** Folders and tags in one call: they are always read together and replaced together. */
    abstract getTaxonomy(guildId: string): Observable<SceneTaxonomyDto>;

    abstract createFolder(guildId: string, dto: CreateSceneFolderDto): Observable<SceneFolderDto>;

    abstract updateFolder(folderId: string, dto: UpdateSceneFolderDto): Observable<SceneFolderDto>;

    abstract deleteFolder(folderId: string): Observable<void>;

    abstract reorderFolders(guildId: string, dto: ReorderSceneFoldersDto): Observable<void>;

    abstract createTag(guildId: string, dto: CreateSceneTagDto): Observable<SceneTagDto>;

    abstract updateTag(tagId: string, dto: UpdateSceneTagDto): Observable<SceneTagDto>;

    abstract deleteTag(tagId: string): Observable<void>;

    abstract setSceneTags(
        guildId: string,
        sceneChannelId: string,
        dto: SetSceneTagsDto,
    ): Observable<{tagIds: string[]}>;
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

    listScenes(guildId: string, params?: SceneListParams): Observable<SceneListDto> {
        return this.http.get<SceneListDto>(`${this.base}/guilds/${guildId}/scenes`, {
            params: sceneListParams(params),
        });
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

    nudgeTurn(guildId: string, sceneChannelId: string): Observable<void> {
        return this.http.post<void>(`${this.scene(guildId, sceneChannelId)}/turn/nudge`, {});
    }

    roll(guildId: string, channelId: string, dto: RollDiceDto): Observable<DiceRollDto> {
        return this.http.post<DiceRollDto>(`${this.base}/guilds/${guildId}/channels/${channelId}/rolls`, dto);
    }

    getTaxonomy(guildId: string): Observable<SceneTaxonomyDto> {
        return this.http.get<SceneTaxonomyDto>(`${this.base}/guilds/${guildId}/scene-taxonomy`);
    }

    createFolder(guildId: string, dto: CreateSceneFolderDto): Observable<SceneFolderDto> {
        return this.http.post<SceneFolderDto>(`${this.base}/guilds/${guildId}/scene-folders`, dto);
    }

    updateFolder(folderId: string, dto: UpdateSceneFolderDto): Observable<SceneFolderDto> {
        return this.http.patch<SceneFolderDto>(`${this.base}/scene-folders/${folderId}`, dto);
    }

    deleteFolder(folderId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/scene-folders/${folderId}`);
    }

    reorderFolders(guildId: string, dto: ReorderSceneFoldersDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/guilds/${guildId}/scene-folders/reorder`, dto);
    }

    createTag(guildId: string, dto: CreateSceneTagDto): Observable<SceneTagDto> {
        return this.http.post<SceneTagDto>(`${this.base}/guilds/${guildId}/scene-tags`, dto);
    }

    updateTag(tagId: string, dto: UpdateSceneTagDto): Observable<SceneTagDto> {
        return this.http.patch<SceneTagDto>(`${this.base}/scene-tags/${tagId}`, dto);
    }

    deleteTag(tagId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/scene-tags/${tagId}`);
    }

    setSceneTags(
        guildId: string,
        sceneChannelId: string,
        dto: SetSceneTagsDto,
    ): Observable<{tagIds: string[]}> {
        return this.http.put<{tagIds: string[]}>(`${this.scene(guildId, sceneChannelId)}/tags`, dto);
    }
}
