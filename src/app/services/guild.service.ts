import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {CategoryDto, ChannelDto, ChannelPermission, GuildDto, GuildKind, RoleDto,} from '../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../dtos/response/guild-safety.dto';
import {environment} from '../../environments/environment';
import {catchError, map, Observable, of, Subject, throwError} from 'rxjs';
import {GuildMemberDto, RoleMemberDto, SelfGuildMemberDto} from '../dtos/response/member.dto';
import {InviteDto} from "../dtos/response/invite.dto";
import {CreateInviteDto} from "../dtos/request/create-invite.dto";
import {ReorderChannesDto} from "../dtos/request/reorder-channel.dto";
import {ApiConfigService} from "./api-config.service";
import {BanDto} from "../dtos/response/ban.dto";
import {AuditLogEntryDto} from "../dtos/response/audit-log-entry.dto";
import {ReorderRolesDto} from "../dtos/request/reorder-roles.dto";
import {CreateThreadDto} from "../dtos/request/create-thread.dto";

export interface UpdateGuildDto {
    name?: string;
    description?: string;
    systemChannelId?: string;
    /** Omitted means "leave unchanged" - the backend treats null as no-op, not clear. */
    verificationLevel?: GuildVerificationLevel;
    /**
     * Sending `kind` **on its own re-seeds `features`** from that kind's preset,
     * discarding whatever the owner customised. Send `features` alongside it to
     * relabel without resetting.
     */
    kind?: GuildKind;
    /** The exact module set, as flag names ("Wiki, Lists") or "None" - never a bitmask. */
    features?: string;
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

export interface OverridePermissionsDto {
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
    /**
     * `kind` seeds the guild's module set from that kind's preset; `features` can't be
     * set at creation, so a non-standard set means creating then PATCHing. Community is
     * the server's own default and is left unsent, keeping a plain server byte-for-byte
     * what the old single-step flow produced.
     */
    createGuild(name: string, description: string | undefined, kind?: GuildKind): Observable<GuildDto> {
        return this.http.post<GuildDto>(`${this.base}/guilds`, {
            name,
            description,
            ...(kind && kind !== GuildKind.Community ? {kind} : {}),
        });
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

    muteMember(guildId: string, memberId: string, durationMinutes: number): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/members/${memberId}/mute`, {durationMinutes});
    }

    unmuteMember(guildId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/${memberId}/mute`);
    }

    leaveGuild(guildId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/me`);
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
        return this.http.patch<ChannelDto>(`${this.base}/channels/${id}`, dto);
    }

    deleteChannel(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${id}`);
    }

    upsertChannelRolePermission(channelId: string, roleId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/channels/${channelId}/permissions/roles/${roleId}`, dto);
    }

    upsertChannelMemberPermission(channelId: string, memberId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/channels/${channelId}/permissions/members/${memberId}`, dto);
    }

    deleteChannelRolePermission(channelId: string, roleId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${channelId}/permissions/roles/${roleId}`);
    }

    deleteChannelMemberPermission(channelId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${channelId}/permissions/members/${memberId}`);
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

    upsertCategoryRolePermission(categoryId: string, roleId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/categories/${categoryId}/permissions/roles/${roleId}`, dto);
    }

    upsertCategoryMemberPermission(categoryId: string, memberId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/categories/${categoryId}/permissions/members/${memberId}`, dto);
    }

    deleteCategoryRolePermission(categoryId: string, roleId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/categories/${categoryId}/permissions/roles/${roleId}`);
    }

    deleteCategoryMemberPermission(categoryId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/categories/${categoryId}/permissions/members/${memberId}`);
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

    /**
     * Who can actually see a channel - the guild members who hold ViewChannel here, after roles and
     * channel overwrites are resolved.
     *
     * Exists for end-to-end encryption, which needs the exact roster: anyone handed group keys can
     * read the traffic, so falling back to the whole member list is a confidentiality bug on any
     * channel with restrictive overwrites, not a cosmetic one.
     */
    getChannelViewers(channelId: string): Observable<string[]> {
        return this.http
            .get<{ channelId: string; userIds: string[] }>(
                `${this.base}/channels/${encodeURIComponent(channelId)}/viewers`)
            .pipe(map(r => r.userIds));
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

    // ── Audit log ────────────────────────────────────────────────────────────
    getAuditLog(guildId: string, skip: number, take: number): Observable<AuditLogEntryDto[]> {
        return this.http.get<AuditLogEntryDto[]>(`${this.base}/guilds/${guildId}/audit-log?skip=${skip}&take=${take}`);
    }

    reorderRoles(guildId: string, dto: ReorderRolesDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/guilds/${guildId}/roles/reorder`, dto);
    }

    // ── Threads ──────────────────────────────────────────────────────────────
    createThread(channelId: string, dto: CreateThreadDto): Observable<ChannelDto> {
        return this.http.post<ChannelDto>(`${this.base}/channels/${channelId}/threads`, dto);
    }

    getThreads(channelId: string): Observable<ChannelDto[]> {
        return this.http.get<ChannelDto[]>(`${this.base}/channels/${channelId}/threads`);
    }

    archiveThread(threadId: string): Observable<void> {
        return this.http.patch<void>(`${this.base}/threads/${threadId}/archive`, {});
    }

    getInviteByCode(code: string): Observable<InviteDto> {
        return this.http.get<InviteDto>(`${this.base}/invites/code/${code}`);
    }
}
