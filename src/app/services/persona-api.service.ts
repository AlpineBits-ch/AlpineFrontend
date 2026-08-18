import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    ChannelAutoproxyDto,
    GuildPersonaDto,
    PersonaDeletionDto,
    PersonaDto,
    PersonaGrantDto,
    PersonaPagePullDto,
} from '../dtos/response/persona.dto';
import {
    CreatePersonaDto,
    CreatePersonaGrantDto,
    PullPersonaPageDto,
    RequestPersonaChangesDto,
    SetAutoproxyDto,
    UpdatePersonaDto,
    UpsertPersonaProfileDto,
} from '../dtos/request/persona.dto';
import {WikiCategoryDto, WikiPageDto} from '../dtos/response/wiki.dto';
import {UpdateWikiPageDto} from '../dtos/request/wiki.dto';
import {WikiService} from './wiki.service';
import {map} from 'rxjs/operators';

/** The persona endpoints, as an injectable seam. `app.config.ts` binds the implementation. */
@Injectable()
export abstract class PersonaApi {
    abstract listOwn(): Observable<PersonaDto[]>;

    abstract createOwn(dto: CreatePersonaDto): Observable<PersonaDto>;

    abstract updateOwn(personaId: string, dto: UpdatePersonaDto): Observable<PersonaDto>;

    abstract deleteOwn(personaId: string): Observable<PersonaDeletionDto>;

    abstract listGuild(guildId: string): Observable<GuildPersonaDto[]>;

    abstract createGuildPersona(guildId: string, dto: CreatePersonaDto): Observable<GuildPersonaDto>;

    abstract updateGuildPersona(
        guildId: string,
        personaId: string,
        dto: UpdatePersonaDto,
    ): Observable<PersonaDto>;

    abstract deleteGuildPersona(guildId: string, personaId: string): Observable<void>;

    abstract listGrants(guildId: string, personaId: string): Observable<PersonaGrantDto[]>;

    abstract addGrant(
        guildId: string,
        personaId: string,
        dto: CreatePersonaGrantDto,
    ): Observable<PersonaGrantDto>;

    abstract removeGrant(guildId: string, personaId: string, grantId: string): Observable<void>;

    abstract putProfile(
        guildId: string,
        personaId: string,
        dto: UpsertPersonaProfileDto,
    ): Observable<GuildPersonaDto>;

    abstract removeProfile(guildId: string, personaId: string): Observable<void>;

    abstract submitProfile(guildId: string, personaId: string): Observable<GuildPersonaDto>;

    abstract approveProfile(guildId: string, personaId: string): Observable<GuildPersonaDto>;

    abstract requestChanges(
        guildId: string,
        personaId: string,
        dto: RequestPersonaChangesDto,
    ): Observable<GuildPersonaDto>;

    abstract listPending(guildId: string): Observable<GuildPersonaDto[]>;

    abstract getAutoproxy(guildId: string, channelId: string): Observable<ChannelAutoproxyDto>;

    abstract setAutoproxy(
        guildId: string,
        channelId: string,
        dto: SetAutoproxyDto,
    ): Observable<ChannelAutoproxyDto>;

    abstract createPage(guildId: string, personaId: string): Observable<WikiPageDto>;

    abstract pullPage(
        guildId: string,
        personaId: string,
        dto: PullPersonaPageDto,
    ): Observable<PersonaPagePullDto>;

    /** A character page is an ordinary wiki page; these three ride the wiki routes. */
    abstract getPage(guildId: string, pageId: string): Observable<WikiPageDto>;

    abstract savePage(guildId: string, pageId: string, dto: UpdateWikiPageDto): Observable<WikiPageDto>;

    /** Categories, for the infobox template a character page is drawn against. */
    abstract listCategories(guildId: string): Observable<WikiCategoryDto[]>;
}

@Injectable()
export class HttpPersonaApi extends PersonaApi {
    private readonly http = inject(HttpClient);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly wiki = inject(WikiService);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    private persona(guildId: string, personaId: string): string {
        return `${this.base}/guilds/${guildId}/personas/${personaId}`;
    }

    listOwn(): Observable<PersonaDto[]> {
        return this.http.get<PersonaDto[]>(`${this.base}/personas`);
    }

    createOwn(dto: CreatePersonaDto): Observable<PersonaDto> {
        return this.http.post<PersonaDto>(`${this.base}/personas`, dto);
    }

    updateOwn(personaId: string, dto: UpdatePersonaDto): Observable<PersonaDto> {
        return this.http.patch<PersonaDto>(`${this.base}/personas/${personaId}`, dto);
    }

    deleteOwn(personaId: string): Observable<PersonaDeletionDto> {
        return this.http.delete<PersonaDeletionDto>(`${this.base}/personas/${personaId}`);
    }

    listGuild(guildId: string): Observable<GuildPersonaDto[]> {
        return this.http.get<GuildPersonaDto[]>(`${this.base}/guilds/${guildId}/personas`);
    }

    createGuildPersona(guildId: string, dto: CreatePersonaDto): Observable<GuildPersonaDto> {
        return this.http.post<GuildPersonaDto>(`${this.base}/guilds/${guildId}/personas`, dto);
    }

    updateGuildPersona(guildId: string, personaId: string, dto: UpdatePersonaDto): Observable<PersonaDto> {
        return this.http.patch<PersonaDto>(this.persona(guildId, personaId), dto);
    }

    deleteGuildPersona(guildId: string, personaId: string): Observable<void> {
        return this.http.delete<void>(this.persona(guildId, personaId));
    }

    listGrants(guildId: string, personaId: string): Observable<PersonaGrantDto[]> {
        return this.http.get<PersonaGrantDto[]>(`${this.persona(guildId, personaId)}/grants`);
    }

    addGrant(guildId: string, personaId: string, dto: CreatePersonaGrantDto): Observable<PersonaGrantDto> {
        return this.http.post<PersonaGrantDto>(`${this.persona(guildId, personaId)}/grants`, dto);
    }

    removeGrant(guildId: string, personaId: string, grantId: string): Observable<void> {
        return this.http.delete<void>(`${this.persona(guildId, personaId)}/grants/${grantId}`);
    }

    putProfile(
        guildId: string,
        personaId: string,
        dto: UpsertPersonaProfileDto,
    ): Observable<GuildPersonaDto> {
        return this.http.put<GuildPersonaDto>(`${this.persona(guildId, personaId)}/profile`, dto);
    }

    removeProfile(guildId: string, personaId: string): Observable<void> {
        return this.http.delete<void>(`${this.persona(guildId, personaId)}/profile`);
    }

    submitProfile(guildId: string, personaId: string): Observable<GuildPersonaDto> {
        return this.http.post<GuildPersonaDto>(`${this.persona(guildId, personaId)}/profile/submit`, {});
    }

    approveProfile(guildId: string, personaId: string): Observable<GuildPersonaDto> {
        return this.http.post<GuildPersonaDto>(`${this.persona(guildId, personaId)}/profile/approve`, {});
    }

    requestChanges(
        guildId: string,
        personaId: string,
        dto: RequestPersonaChangesDto,
    ): Observable<GuildPersonaDto> {
        return this.http.post<GuildPersonaDto>(
            `${this.persona(guildId, personaId)}/profile/request-changes`,
            dto,
        );
    }

    listPending(guildId: string): Observable<GuildPersonaDto[]> {
        return this.http.get<GuildPersonaDto[]>(`${this.base}/guilds/${guildId}/personas/pending`);
    }

    getAutoproxy(guildId: string, channelId: string): Observable<ChannelAutoproxyDto> {
        return this.http.get<ChannelAutoproxyDto>(
            `${this.base}/guilds/${guildId}/channels/${channelId}/autoproxy`,
        );
    }

    setAutoproxy(guildId: string, channelId: string, dto: SetAutoproxyDto): Observable<ChannelAutoproxyDto> {
        return this.http.put<ChannelAutoproxyDto>(
            `${this.base}/guilds/${guildId}/channels/${channelId}/autoproxy`,
            dto,
        );
    }

    createPage(guildId: string, personaId: string): Observable<WikiPageDto> {
        return this.http.post<WikiPageDto>(`${this.persona(guildId, personaId)}/page`, {});
    }

    pullPage(guildId: string, personaId: string, dto: PullPersonaPageDto): Observable<PersonaPagePullDto> {
        return this.http.post<PersonaPagePullDto>(`${this.persona(guildId, personaId)}/page/pull`, dto);
    }

    getPage(guildId: string, pageId: string): Observable<WikiPageDto> {
        return this.wiki.getPage(guildId, pageId);
    }

    savePage(guildId: string, pageId: string, dto: UpdateWikiPageDto): Observable<WikiPageDto> {
        return this.wiki.updatePage(guildId, pageId, dto);
    }

    listCategories(guildId: string): Observable<WikiCategoryDto[]> {
        return this.wiki.getWiki(guildId).pipe(map(wiki => wiki.categories));
    }
}
