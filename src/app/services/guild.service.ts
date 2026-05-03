import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {
  CategoryDto,
  ChannelDto,
  ChannelPermission,
  GuildDto,
  InviteDto,
  InviteType,
  RoleDto,
} from '../dtos/response/guild.dto';
import {environment} from '../../environments/environment';
import {Observable} from 'rxjs';
import {GuildMemberDto} from '../dtos/response/member.dto';

export interface UpdateGuildDto {
  name?: string;
  description?: string;
}

export interface CreateRoleDto {
  guildId: string;
  name: string;
  description?: string;
  color?: string;
  permissions?: string;
}

export interface UpdateRoleDto {
  name?: string;
  description?: string;
  color?: string;
  permissions?: string;
}

export interface CreateChannelDto {
  guildId: string;
  name: string;
  description?: string;
  type: string;
  categoryId?: string;
  isPrivate?: boolean;
  isAgeRestricted?: boolean;
}

export interface UpdateChannelDto {
  name?: string;
  description?: string;
  isPrivate?: boolean;
  isAgeRestricted?: boolean;
  categoryId?: string | null;
}

export interface CreateCategoryDto {
  guildId: string;
  name: string;
  description?: string;
}

export interface UpdateCategoryDto {
  name?: string;
  description?: string;
}

export interface UpsertPermissionOverrideDto {
  roleId?: string;
  memberId?: string;
  allowPermissions: string;
  denyPermissions: string;
}

export interface CreateInviteDto {
  guildId: string;
  type: InviteType;
}

export interface GuildMemberWithProfileDto extends GuildMemberDto {
  username?: string;
  displayName?: string;
  avatarUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class GuildService {
  private http = inject(HttpClient);
  private base = environment.apiUrl + '/api/v1/guild';

  // ── Guilds ──────────────────────────────────────────────────────────────
  createGuild(name: string, description: string | undefined): Observable<GuildDto> {
    return this.http.post<GuildDto>(`${this.base}/guilds`, {name, description});
  }

  getGuilds(): Observable<GuildDto[]> {
    return this.http.get<GuildDto[]>(`${this.base}/guilds`);
  }

  getGuild(id: string): Observable<GuildDto> {
    return this.http.get<GuildDto>(`${this.base}/guild/${id}`);
  }

  updateGuild(id: string, dto: UpdateGuildDto): Observable<GuildDto> {
    return this.http.patch<GuildDto>(`${this.base}/guild/${id}`, dto);
  }

  deleteGuild(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/guild/${id}`);
  }

  uploadGuildIcon(id: string, file: File): Observable<GuildDto> {
    const fd = new FormData();
    fd.append('icon', file);
    return this.http.post<GuildDto>(`${this.base}/guild/${id}/icon`, fd);
  }

  removeGuildIcon(id: string): Observable<GuildDto> {
    return this.http.delete<GuildDto>(`${this.base}/guild/${id}/icon`);
  }

  // ── Members ─────────────────────────────────────────────────────────────


  updateMemberPermissions(guildId: string, memberId: string, permissions: string): Observable<GuildMemberDto> {
    return this.http.patch<GuildMemberDto>(`${this.base}/guild/${guildId}/member/${memberId}`, {permissions});
  }

  kickMember(guildId: string, memberId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/guild/${guildId}/member/${memberId}`);
  }

  // ── Roles ────────────────────────────────────────────────────────────────
  createRole(dto: CreateRoleDto): Observable<RoleDto> {
    return this.http.post<RoleDto>(`${this.base}/guild/${dto.guildId}/role`, dto);
  }

  updateRole(id: string, dto: UpdateRoleDto): Observable<RoleDto> {
    return this.http.patch<RoleDto>(`${this.base}/role/${id}`, dto);
  }

  deleteRole(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/role/${id}`);
  }

  assignRoleToMember(roleId: string, memberId: string): Observable<void> {
    return this.http.post<void>(`${this.base}/role/${roleId}/member`, {memberId});
  }

  removeRoleFromMember(roleId: string, memberId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/role/${roleId}/member/${memberId}`);
  }

  // ── Channels ─────────────────────────────────────────────────────────────
  createChannel(dto: CreateChannelDto): Observable<ChannelDto> {
    return this.http.post<ChannelDto>(`${this.base}/guild/${dto.guildId}/channel`, dto);
  }

  updateChannel(id: string, dto: UpdateChannelDto): Observable<ChannelDto> {
    return this.http.patch<ChannelDto>(`${this.base}/channel/${id}`, dto);
  }

  deleteChannel(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/channel/${id}`);
  }

  upsertChannelPermission(channelId: string, dto: UpsertPermissionOverrideDto): Observable<ChannelPermission> {
    return this.http.put<ChannelPermission>(`${this.base}/channel/${channelId}/permission`, dto);
  }

  deleteChannelPermission(channelId: string, permissionId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/channel/${channelId}/permission/${permissionId}`);
  }

  // ── Categories ───────────────────────────────────────────────────────────
  createCategory(dto: CreateCategoryDto): Observable<CategoryDto> {
    return this.http.post<CategoryDto>(`${this.base}/guild/${dto.guildId}/category`, dto);
  }

  updateCategory(id: string, dto: UpdateCategoryDto): Observable<CategoryDto> {
    return this.http.patch<CategoryDto>(`${this.base}/category/${id}`, dto);
  }

  deleteCategory(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/category/${id}`);
  }

  upsertCategoryPermission(categoryId: string, dto: UpsertPermissionOverrideDto): Observable<ChannelPermission> {
    return this.http.put<ChannelPermission>(`${this.base}/category/${categoryId}/permission`, dto);
  }

  deleteCategoryPermission(categoryId: string, permissionId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/category/${categoryId}/permission/${permissionId}`);
  }

  // ── Invites ──────────────────────────────────────────────────────────────
  createInvite(dto: CreateInviteDto): Observable<InviteDto> {
    return this.http.post<InviteDto>(`${this.base}/guild/${dto.guildId}/invite`, dto);
  }

  getInvites(guildId: string): Observable<InviteDto[]> {
    return this.http.get<InviteDto[]>(`${this.base}/guild/${guildId}/invite`);
  }

  deleteInvite(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/invite/${id}`);
  }

  getMembers(guildId: string, skip: number, take: number): Observable<GuildMemberDto[]> {
    return this.http.get<GuildMemberDto[]>(`${this.base}/guilds/${guildId}/members?skip=${skip}&take=${take}`);
  }
}
