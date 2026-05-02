import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { GuildDto, GuildMemberDto, InviteDto, InviteType, RoleDto } from '../dtos/response/guild.dto';
import { RoleMemberDto } from '../dtos/response/member.dto';
import { environment } from '../../environments/environment';

const BASE = environment.apiUrl + '/api/v1/guild';

@Injectable({ providedIn: 'root' })
export class GuildService {
  private http = inject(HttpClient);

  createGuild(name: string, description: string | undefined): Observable<GuildDto> {
    return this.http.post<GuildDto>(`${BASE}/guilds`, { name, description });
  }

  getGuilds(): Observable<GuildDto[]> {
    return this.http.get<GuildDto[]>(`${BASE}/guilds`);
  }

  updateGuild(id: string, name: string, description?: string): Observable<GuildDto> {
    return this.http.patch<GuildDto>(`${BASE}/guilds/${id}`, { name, description });
  }

  // ── Members ──────────────────────────────────────────────────────────────

  getMembers(guildId: string): Observable<GuildMemberDto[]> {
    return this.http.get<GuildMemberDto[]>(`${BASE}/guilds/${guildId}/members`);
  }

  updateMember(memberId: string, permissions: string): Observable<GuildMemberDto> {
    return this.http.patch<GuildMemberDto>(`${BASE}/members/${memberId}`, { permissions });
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  createRole(guildId: string, name: string, color: string, permissions: string): Observable<RoleDto> {
    return this.http.post<RoleDto>(`${BASE}/roles`, { guildId, name, color, permissions });
  }

  updateRole(id: string, name: string, description: string, color: string, permissions: string): Observable<RoleDto> {
    return this.http.patch<RoleDto>(`${BASE}/roles/${id}`, { name, description, color, permissions });
  }

  deleteRole(id: string): Observable<void> {
    return this.http.delete<void>(`${BASE}/roles/${id}`);
  }

  // ── Role membership ───────────────────────────────────────────────────────

  getMemberRoles(memberId: string): Observable<RoleMemberDto[]> {
    return this.http.get<RoleMemberDto[]>(`${BASE}/role-members/member/${memberId}`);
  }

  assignRole(memberId: string, roleId: string): Observable<RoleMemberDto> {
    return this.http.post<RoleMemberDto>(`${BASE}/role-members`, { memberId, roleId });
  }

  revokeRole(roleMemberId: string): Observable<void> {
    return this.http.delete<void>(`${BASE}/role-members/${roleMemberId}`);
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  getInvites(guildId: string): Observable<InviteDto[]> {
    return this.http.get<InviteDto[]>(`${BASE}/guilds/${guildId}/invites`);
  }

  createInvite(guildId: string, type: InviteType): Observable<InviteDto> {
    return this.http.post<InviteDto>(`${BASE}/invites`, { guildId, type });
  }

  revokeInvite(id: string): Observable<void> {
    return this.http.delete<void>(`${BASE}/invites/${id}`);
  }
}
