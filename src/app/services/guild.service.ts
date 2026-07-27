import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {CategoryDto, ChannelDto, ChannelPermission, GuildDto, RoleDto,} from '../dtos/response/guild.dto';
import {environment} from '../../environments/environment';
import {catchError, Observable, of, Subject, throwError} from 'rxjs';
import {GuildMemberDto, RoleMemberDto, SelfGuildMemberDto} from '../dtos/response/member.dto';
import {InviteDto} from "../dtos/response/invite.dto";
import {CreateInviteDto} from "../dtos/request/create-invite.dto";
import {ReorderChannesDto} from "../dtos/request/reorder-channel.dto";
import {ApiConfigService} from "./api-config.service";
import {BanDto} from "../dtos/response/ban.dto";

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
    position: number
}

export interface UpdateChannelDto {
    name: string;
    description?: string;
    isAgeRestricted: boolean;
    isPrivate: boolean;
    slowModeSeconds: number;
}

export interface CreateCategoryDto {
    guildId: string;
    name: string;
    description?: string;
    position: number;
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


export interface GuildMemberWithProfileDto extends GuildMemberDto {
    username?: string;
    displayName?: string;
    avatarUrl?: string;
}

@Injectable({providedIn: 'root'})
export class GuildService {
    readonly guildJoined$ = new Subject<void>();
    readonly guildUpdated$ = new Subject<GuildDto>();
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);
    private base = this.apiConfig.baseUrl() + '/api/v1/guild';

    // ── Guilds ──────────────────────────────────────────────────────────────
    createGuild(name: string, description: string | undefined): Observable<GuildDto> {
        return this.http.post<GuildDto>(`${this.base}/guilds`, {name, description});
    }

    getGuilds(): Observable<GuildDto[]> {
        return this.http.get<GuildDto[]>(`${this.base}/guilds`);
    }

    getGuild(id: string): Observable<GuildDto> {
        return this.http.get<GuildDto>(`${this.base}/guilds/${id}`);
    }


    reorderChannels(guildId: string, dto: ReorderChannesDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/guilds/${guildId}/channels/reorder`, dto);
    }

    updateGuild(id: string, dto: UpdateGuildDto): Observable<GuildDto> {
        return this.http.patch<GuildDto>(`${this.base}/guilds/${id}`, dto);
    }

    deleteGuild(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${id}`);
    }

    uploadGuildIcon(id: string, file: File): Observable<GuildDto> {
        const fd = new FormData();
        fd.append('file', file);
        return this.http.post<GuildDto>(`${this.base}/guilds/${id}/icon`, fd);
    }

    removeGuildIcon(id: string): Observable<GuildDto> {
        return this.http.delete<GuildDto>(`${this.base}/guilds/${id}/icon`);
    }

    // ── Members ─────────────────────────────────────────────────────────────


    updateMemberPermissions(guildId: string, memberId: string, permissions: string): Observable<GuildMemberDto> {
        return this.http.patch<GuildMemberDto>(`${this.base}/guild/${guildId}/member/${memberId}`, {permissions});
    }

    kickMember(guildId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/${memberId}`);
    }

    kickMemberByUserId(guildId: string, userId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/by-user/${userId}`);
    }

    banMember(guildId: string, dto: {userId: string; reason?: string}): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/bans`, dto);
    }

    getBans(guildId: string): Observable<BanDto[]> {
        return this.http.get<BanDto[]>(`${this.base}/guilds/${guildId}/bans`);
    }

    unbanMember(guildId: string, userId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/bans/${userId}`);
    }

    // ── Roles ────────────────────────────────────────────────────────────────
    createRole(dto: CreateRoleDto): Observable<RoleDto> {
        return this.http.post<RoleDto>(`${this.base}/guilds/${dto.guildId}/roles`, dto);
    }

    updateRole(id: string, dto: UpdateRoleDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/roles/${id}`, dto);
    }

    deleteRole(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/roles/${id}`);
    }

    assignRoleToMember(roleId: string, memberId: string): Observable<void> {
        return this.http.put<void>(`${this.base}/roles/${roleId}/members/${memberId}`, {});
    }

    getRoleMembers(roleId: string, skip: number, take: number): Observable<RoleMemberDto[]> {
        return this.http.get<RoleMemberDto[]>(`${this.base}/roles/${roleId}/members?skip=${skip}&take=${take}`);
    }

    searchRoleMembers(roleId: string, search: string): Observable<RoleMemberDto[]> {
        return this.http.get<RoleMemberDto[]>(
            `${this.base}/roles/${roleId}/members/search?search=${encodeURIComponent(search)}`
        );
    }

    removeRoleFromMember(roleId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/roles/${roleId}/members/${memberId}`);
    }

    // ── Channels ─────────────────────────────────────────────────────────────
    createChannel(dto: CreateChannelDto): Observable<ChannelDto> {
        return this.http.post<ChannelDto>(`${this.base}/guilds/${dto.guildId}/channels`, dto);
    }

    updateChannel(id: string, dto: UpdateChannelDto): Observable<ChannelDto> {
        return this.http.patch<ChannelDto>(`${this.base}/channel/${id}`, dto);
    }

    deleteChannel(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${id}`);
    }

    upsertChannelPermission(channelId: string, dto: UpsertPermissionOverrideDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/channel/${channelId}/permission`, dto);
    }

    deleteChannelPermission(channelId: string, permissionId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channel/${channelId}/permission/${permissionId}`);
    }

    // ── Categories ───────────────────────────────────────────────────────────
    createCategory(dto: CreateCategoryDto): Observable<CategoryDto> {
        return this.http.post<CategoryDto>(`${this.base}/guilds/${dto.guildId}/categories`, dto);
    }

    updateCategory(id: string, dto: UpdateCategoryDto): Observable<CategoryDto> {
        return this.http.patch<CategoryDto>(`${this.base}/category/${id}`, dto);
    }

    deleteCategory(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/categories/${id}`);
    }

    upsertCategoryPermission(categoryId: string, dto: UpsertPermissionOverrideDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/category/${categoryId}/permission`, dto);
    }

    deleteCategoryPermission(categoryId: string, permissionId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/category/${categoryId}/permission/${permissionId}`);
    }

    // ── Invites ──────────────────────────────────────────────────────────────
    createInvite(dto: CreateInviteDto, guildId: string): Observable<InviteDto> {
        return this.http.post<InviteDto>(`${this.base}/guilds/${guildId}/invite`, dto);
    }

    getInvites(guildId: string): Observable<InviteDto[]> {
        return this.http.get<InviteDto[]>(`${this.base}/guilds/${guildId}/invites`);
    }

    getInvite(id: string): Observable<InviteDto> {
        return this.http.get<InviteDto>(`${this.base}/invites/${id}`);
    }

    redeemInvite(id: string): Observable<unknown> {
        return this.http.post(`${this.base}/invites/${id}/redeem`, {});
    }

    deleteInvite(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/invites/${id}`);
    }

    getMembers(guildId: string, skip: number, take: number): Observable<GuildMemberDto[]> {
        return this.http.get<GuildMemberDto[]>(`${this.base}/guilds/${guildId}/members?skip=${skip}&take=${take}`);
    }

    searchMembers(guildId: string, search: string): Observable<GuildMemberDto[]> {
        return this.http.get<GuildMemberDto[]>(
            `${this.base}/guilds/${guildId}/members/search?search=${encodeURIComponent(search)}`
        ).pipe(
            catchError(err => err.status === 404 ? of([]) : throwError(() => err))
        );
    }

    getOwnMember(guildId: string): Observable<SelfGuildMemberDto> {
        return this.http.get<SelfGuildMemberDto>(`${this.base}/guilds/${guildId}/me`);
    }
}
