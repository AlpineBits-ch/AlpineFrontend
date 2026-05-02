import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {GuildDto} from "../dtos/response/guild.dto";
import {environment} from "../../environments/environment";
import {Observable} from "rxjs";

@Injectable({
  providedIn: 'root',
})
export class GuildService {
  private http = inject(HttpClient);
  public createGuild(name: string, description: string | undefined){

    return this.http.post<GuildDto>(environment.apiUrl+ '/api/v1/guild/guilds', {name, description});
  }

  public getGuilds(): Observable<GuildDto[]>{
    return this.http.get<GuildDto[]>(environment.apiUrl+ '/api/v1/guild/guilds');
  }
}
