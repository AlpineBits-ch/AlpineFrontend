import {inject, Injectable, signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {
    CategoryDto,
    ChannelDto,
    ChannelPermission,
    GuildDto,
    GuildKind,
    RoleDto,
} from '../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../dtos/response/guild-safety.dto';
import {GuildFeatureResolutionDto} from '../dtos/response/entitlement.dto';
import {environment} from '../../environments/environment';
import {catchError, finalize, map, Observable, of, shareReplay, Subject, tap, throwError} from 'rxjs';
import {
    GuildMemberDto,
    MemberPermissionsDto,
    RoleMemberDto,
    SelfGuildMemberDto,
} from '../dtos/response/member.dto';
import {InviteDto, RedeemInviteResultDto} from '../dtos/response/invite.dto';
import {CreateInviteDto} from '../dtos/request/create-invite.dto';
import {ReorderChannesDto} from '../dtos/request/reorder-channel.dto';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {ProfileDto} from '../dtos/response/profile.dto';
import {BanDto} from '../dtos/response/ban.dto';
import {AuditLogEntryDto} from '../dtos/response/audit-log-entry.dto';
import {ReorderRolesDto} from '../dtos/request/reorder-roles.dto';
import {CreateThreadDto} from '../dtos/request/create-thread.dto';
import {MoveOutSummary} from '../dtos/response/move-out.dto';
import {
    clearGuildLayoutCache,
    readGuildLayoutCache,
    reviveGuildDates,
    writeGuildLayoutCache,
} from './guild-layout-cache';
import {reconcileGuilds} from './guild-reconcile';

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
    modulePermissions?: string;
    hoist?: boolean;
    mentionable?: boolean;
}

/**
 * A real PATCH: an omitted field is left alone, where it used to be written as null.
 *
 * <p>The consequence for callers is that clearing a value is only expressible as an empty string.
 * Dropping `description` no longer erases it.</p>
 */
export interface UpdateRoleDto {
    name?: string;
    description?: string;
    color?: string;
    permissions?: string;
    modulePermissions?: string;
    hoist?: boolean;
    mentionable?: boolean;
    unicodeEmoji?: string | null;
}

export interface CreateChannelDto {
    guildId: string;
    name: string;
    description?: string;
    type: string;
    categoryId?: string;
    isPrivate?: boolean;
    isAgeRestricted?: boolean;
    position: number;
}

export interface UpdateChannelDto {
    name: string;
    description?: string;
    isAgeRestricted: boolean;
    isPrivate: boolean;
    slowModeSeconds: number;
    /** Empty string clears it back to the type default; omitting it leaves the stored value alone. */
    icon?: string;
    iconColor?: string;
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

/**
 * Core mask only, deliberately.
 *
 * <p>`ChannelPermission` also stores an allow/deny pair of {@link ModulePermissions}, and the
 * server resolves them, but `SetPermissionOverwriteDto` has no field to carry them - so a module
 * overwrite can be enforced and read, never written. Until the server grows the pair, the editor
 * shows those bits read-only rather than offering a control that saves nothing.</p>
 */
export interface OverridePermissionsDto {
    allowPermissions: string;
    denyPermissions: string;
}

export interface GuildMemberWithProfileDto extends GuildMemberDto {
    username?: string;
    displayName?: string;
    avatarUrl?: string;
}

/**
 * How long a cached own-member row is served before it is read again.
 *
 * <p>Not a performance knob - it is the self-healing property the old uncached code had for free.
 * Every change we are *told* about invalidates explicitly (see {@link GuildService.invalidateOwnMember}),
 * so this only covers changes nobody told us about: a `guild.MemberUpdated` that landed while the
 * realtime socket was reconnecting is simply never delivered, and without an expiry the row it
 * described would stay wrong for the rest of the session. Before the cache, reopening the guild
 * fixed that; with an unbounded cache, nothing would. Half a minute keeps the guild-open burst
 * collapsed to one request while bounding how long a missed demotion can show controls that
 * 403.</p>
 */
const OWN_MEMBER_TTL_MS = 30_000;

interface CachedOwnMember {
    row: SelfGuildMemberDto;
    /** `Date.now()` when the response landed, for the {@link OWN_MEMBER_TTL_MS} comparison. */
    at: number;
}

@Injectable({providedIn: 'root'})
export class GuildService {
    readonly guildJoined$ = new Subject<void>();
    readonly guildUpdated$ = new Subject<GuildDto>();

    /**
     * <b>The</b> guild list. Every consumer reads this one - the server rail, the titlebar inbox
     * that counts mentions across all of them, the household boards, the wiki, the composer.
     *
     * <p>`ServerTaskbarComponent` used to keep a second copy and mutate it locally for websocket
     * events while ten other places read this one, which is how the rail and everything else could
     * disagree about what guilds exist. The websocket handlers now call {@link upsertGuild} and
     * {@link removeGuild} instead, so there is one list and one place that writes it.</p>
     *
     * <p><b>Populated before the first request is issued</b>, from the layout this account left on
     * disk last time - see `guild-layout-cache`. Empty means a genuinely cold profile, a cache this
     * account has not written yet, or storage that would not answer; all three fall back to what
     * shipped before, which is waiting for {@link getGuilds}.</p>
     */
    readonly guilds = signal<readonly GuildDto[]>(readGuildLayoutCache());

    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);
    /** Only ever written to - see {@link seedProfiles}. Nothing here reads a profile back. */
    private profiles = inject(ProfileService);
    private base = this.apiConfig.baseUrl() + '/api/v1/guild';

    /** The last own-member row read for each guild, until it is invalidated or ages out. */
    private ownMemberCache = new Map<string, CachedOwnMember>();

    /**
     * The `/me` read already on the wire for each guild, so callers that arrive together join it.
     *
     * <p><b>This, not the cache, is what fixes the guild-open burst.</b> A cache is only written
     * when a response lands, and opening a guild mounts the channel list, the channel view, the
     * member list and whichever household board is on screen inside a single change-detection
     * pass - all of them looked at an empty cache, agreed there was nothing there, and issued
     * their own GET for the same row. Three to five identical requests, every open.</p>
     *
     * <p>Entries are dropped when the request settles, so this is a coalescing window rather than
     * a second cache: a failure leaves nothing behind and the next caller may retry.</p>
     */
    private ownMemberInFlight = new Map<string, Observable<SelfGuildMemberDto>>();

    /**
     * Bumped per guild by {@link invalidateOwnMember}, so a response that was computed before an
     * invalidation cannot be written to the cache after it.
     *
     * <p>Without this the narrowest race loses the demotion outright: the first read is still on
     * the wire when `guild.MemberUpdated` arrives, the invalidation clears an empty cache, and the
     * pre-change response then lands and installs itself as the fresh row - which every host that
     * the revision bump just told to re-read is then handed.</p>
     */
    private ownMemberEpoch = new Map<string, number>();

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

    /**
     * Refreshes the guild list.
     *
     * <p><b>Emits the reconciled list, not the raw response.</b> Subscribers have to end up holding
     * the same objects {@link guilds} holds: `ServerTaskbarComponent` passes what it receives here
     * straight to `NavigationService.tryRestoreGuildNav`, and a second identity for the same guild
     * landing in `workspace` is exactly the cascade {@link reconcileGuilds} exists to prevent.</p>
     */
    getGuilds(): Observable<GuildDto[]> {
        return this.http
            .get<GuildDto[]>(`${this.base}/guilds`)
            .pipe(map(fresh => this.publish(reconcileGuilds(this.guilds(), fresh.map(reviveGuildDates)))));
    }

    getGuild(id: string): Observable<GuildDto> {
        return this.http.get<GuildDto>(`${this.base}/guilds/${id}`);
    }

    /**
     * One guild's module resolution on its own - what the owner chose, what the plan covers, what
     * it withholds, and what is actually on.
     *
     * <p>Its own route rather than {@link getGuild} because this is what gets refetched when an
     * `entitlements.Changed` push lands: re-pulling a guild's entire channel, category and role
     * tree to learn that Forums went out of plan is a payload proportional to the guild's structure
     * for four short lists.</p>
     */
    getGuildFeatures(id: string): Observable<GuildFeatureResolutionDto> {
        return this.http.get<GuildFeatureResolutionDto>(`${this.base}/guilds/${id}/features`);
    }

    /**
     * Puts one guild into {@link guilds}, replacing the entry with the same id or appending it.
     *
     * <p>For the paths that learn about a single guild rather than the whole list: a guild created
     * here or on another device, a `guildUpdated` refetch, a settings save. Keyed on id rather than
     * appended, because SignalR redelivers after a reconnect and an append would double the rail.</p>
     *
     * <p>Goes through {@link reconcileGuilds} like everything else, so republishing a guild that has
     * not actually changed - which the `guildUpdated` handler does routinely - costs nothing.</p>
     */
    upsertGuild(guild: GuildDto): void {
        const fresh = reviveGuildDates(guild);
        const current = this.guilds();
        const next = current.some(g => g.id === fresh.id)
            ? current.map(g => (g.id === fresh.id ? fresh : g))
            : [...current, fresh];
        this.publish(reconcileGuilds(current, next));
    }

    /** Drops a guild that was deleted, or that this account left. A no-op if it was never there. */
    removeGuild(guildId: string): void {
        const current = this.guilds();
        const next = current.filter(g => g.id !== guildId);
        if (next.length === current.length) return;
        this.publish(next);
    }

    /**
     * Forgets the list and the copy of it on disk.
     *
     * <p>For the end of a session. The list names servers this account is a member of and the
     * channels inside them, so it has to go with the tokens rather than linger for whoever signs in
     * next - see `runSignOut`, which is the ordered description of that.</p>
     */
    forgetCachedGuilds(): void {
        this.guilds.set([]);
        clearGuildLayoutCache();
    }

    /**
     * The one place {@link guilds} is written, so the on-disk copy cannot drift from the in-memory
     * one.
     *
     * <p>The identity check is not an optimisation of the write - it is what makes a reconcile that
     * found nothing new genuinely free. {@link reconcileGuilds} returns the *same array* in that
     * case, `set` with it notifies nobody under Angular's default equality, and there is nothing to
     * re-serialize either.</p>
     */
    private publish(next: readonly GuildDto[]): GuildDto[] {
        if (next !== this.guilds()) {
            this.guilds.set(next);
            writeGuildLayoutCache(next);
        }
        // The list is treated as immutable everywhere; the cast only drops a `readonly` the public
        // observable's signature predates.
        return this.guilds() as GuildDto[];
    }

    reorderChannels(guildId: string, dto: ReorderChannesDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/guilds/${guildId}/channels/reorder`, dto);
    }

    updateGuild(id: string, dto: UpdateGuildDto): Observable<GuildDto> {
        // `kind`/`features` re-seed the module set, and the resolved permission mask is clamped to
        // enabled modules - so this can strip bits from a member row whose roles never moved.
        return this.http
            .patch<GuildDto>(`${this.base}/guilds/${id}`, dto)
            .pipe(tap(() => this.invalidateOwnMember(id)));
    }

    deleteGuild(id: string): Observable<void> {
        return this.http
            .delete<void>(`${this.base}/guilds/${id}`)
            .pipe(tap(() => this.invalidateOwnMember(id)));
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

    /**
     * Sets the member's own guild-level allow mask - their overrides, not the sum of their roles.
     *
     * <p>Only `allowPermissions` is sent. The other three masks the endpoint accepts (deny, and
     * both module masks) are omitted, which it reads as "leave alone": the dialog driving this is a
     * two-state grid over the core space and has no way to show, let alone preserve, the rest.</p>
     *
     * <p>The member id is somebody else's in every screen that calls this today, but the route does
     * not stop it being ours and the cached row would keep the old mask if it were. Dropping it
     * costs one refetch; not dropping it costs a permission gate that disagrees with the server.</p>
     */
    updateMemberPermissions(
        guildId: string,
        memberId: string,
        permissions: string,
    ): Observable<MemberPermissionsDto> {
        return this.http
            .patch<MemberPermissionsDto>(`${this.base}/guilds/${guildId}/members/${memberId}/permissions`, {
                allowPermissions: permissions,
            })
            .pipe(tap(() => this.invalidateOwnMember(guildId)));
    }

    kickMember(guildId: string, memberId: string): Observable<void> {
        return this.http
            .delete<void>(`${this.base}/guilds/${guildId}/members/${memberId}`)
            .pipe(tap(() => this.invalidateOwnMember(guildId)));
    }

    kickMemberByUserId(guildId: string, userId: string): Observable<void> {
        return this.http
            .delete<void>(`${this.base}/guilds/${guildId}/members/by-user/${userId}`)
            .pipe(tap(() => this.invalidateOwnMember(guildId)));
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
        return this.http.post<void>(`${this.base}/guilds/${guildId}/members/${memberId}/mute`, {
            durationMinutes,
        });
    }

    unmuteMember(guildId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/${memberId}/mute`);
    }

    /**
     * The row is gone the moment this succeeds, and keeping it would survive a rejoin: redeeming
     * an invite to the same guild inside the TTL would be answered with the roles the membership
     * that just ended had.
     */
    leaveGuild(guildId: string): Observable<void> {
        return this.http
            .delete<void>(`${this.base}/guilds/${guildId}/members/me`)
            .pipe(tap(() => this.invalidateOwnMember(guildId)));
    }

    /**
     * Moves a member out of a household. Addressed by **user id**, not member id.
     *
     * <p>This is not a kick with a friendlier name, and it is not interchangeable with one: a
     * household has the Moderation module off, so {@link kickMember} answers `403` there for
     * everybody including the owner. It needs `ManageGuild` plus the usual role-hierarchy rule, and
     * the owner cannot be moved out at all - ownership has to be transferred first.</p>
     *
     * <p><b>`409` is the normal path, not an error.</b> A member who still owes money is refused
     * with a {@link MoveOutConflict} listing what is outstanding, and the caller has to come back
     * with `writeOffBalances: true` once the house has decided to stop counting the debt. Sending
     * it up front skips a decision that is not the client's to make.</p>
     */
    moveOutMember(guildId: string, userId: string, writeOffBalances = false): Observable<MoveOutSummary> {
        return this.http
            .post<MoveOutSummary>(`${this.base}/guilds/${guildId}/members/${userId}/move-out`, {
                writeOffBalances,
            })
            .pipe(tap(() => this.invalidateOwnMember(guildId)));
    }

    // ── Roles ────────────────────────────────────────────────────────────────
    createRole(dto: CreateRoleDto): Observable<RoleDto> {
        return this.http.post<RoleDto>(`${this.base}/guilds/${dto.guildId}/roles`, dto);
    }

    /**
     * Role routes are addressed by role id and name no guild, so the whole cache goes rather than
     * one entry. At most one refetch per guild whose row is warm, for an action nobody performs in
     * a loop - and the alternative is a role edit that leaves our own resolved permissions stale.
     */
    updateRole(id: string, dto: UpdateRoleDto): Observable<void> {
        return this.http
            .patch<void>(`${this.base}/roles/${id}`, dto)
            .pipe(tap(() => this.invalidateOwnMember()));
    }

    deleteRole(id: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/roles/${id}`).pipe(tap(() => this.invalidateOwnMember()));
    }

    assignRoleToMember(roleId: string, memberId: string): Observable<void> {
        return this.http
            .put<void>(`${this.base}/roles/${roleId}/members/${memberId}`, {})
            .pipe(tap(() => this.invalidateOwnMember()));
    }

    getRoleMembers(roleId: string, skip: number, take: number): Observable<RoleMemberDto[]> {
        return this.http.get<RoleMemberDto[]>(
            `${this.base}/roles/${roleId}/members?skip=${skip}&take=${take}`,
        );
    }

    searchRoleMembers(roleId: string, search: string): Observable<RoleMemberDto[]> {
        return this.http.get<RoleMemberDto[]>(
            `${this.base}/roles/${roleId}/members/search?search=${encodeURIComponent(search)}`,
        );
    }

    removeRoleFromMember(roleId: string, memberId: string): Observable<void> {
        return this.http
            .delete<void>(`${this.base}/roles/${roleId}/members/${memberId}`)
            .pipe(tap(() => this.invalidateOwnMember()));
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

    upsertChannelRolePermission(
        channelId: string,
        roleId: string,
        dto: OverridePermissionsDto,
    ): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(
            `${this.base}/channels/${channelId}/permissions/roles/${roleId}`,
            dto,
        );
    }

    upsertChannelMemberPermission(
        channelId: string,
        memberId: string,
        dto: OverridePermissionsDto,
    ): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(
            `${this.base}/channels/${channelId}/permissions/members/${memberId}`,
            dto,
        );
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

    upsertCategoryRolePermission(
        categoryId: string,
        roleId: string,
        dto: OverridePermissionsDto,
    ): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(
            `${this.base}/categories/${categoryId}/permissions/roles/${roleId}`,
            dto,
        );
    }

    upsertCategoryMemberPermission(
        categoryId: string,
        memberId: string,
        dto: OverridePermissionsDto,
    ): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(
            `${this.base}/categories/${categoryId}/permissions/members/${memberId}`,
            dto,
        );
    }

    deleteCategoryRolePermission(categoryId: string, roleId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/categories/${categoryId}/permissions/roles/${roleId}`);
    }

    deleteCategoryMemberPermission(categoryId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(
            `${this.base}/categories/${categoryId}/permissions/members/${memberId}`,
        );
    }

    // ── Invites ──────────────────────────────────────────────────────────────
    createInvite(dto: CreateInviteDto, guildId: string): Observable<InviteDto> {
        return this.http.post<InviteDto>(`${this.base}/guilds/${guildId}/invite`, dto);
    }

    /**
     * Every live join credential for the guild. Needs `ManageGuild` - not `ManageChannel`, which is
     * both the wrong scope and the wrong level of trust for the whole set.
     *
     * <p>Revoked invites are excluded unless `includeRevoked` is set, which is the audit view.</p>
     */
    getInvites(guildId: string, includeRevoked = false): Observable<InviteDto[]> {
        const query = includeRevoked ? '?includeRevoked=true' : '';
        return this.http.get<InviteDto[]>(`${this.base}/guilds/${guildId}/invites${query}`);
    }

    /**
     * Unauthenticated preview of one invite. **Rate limited** - 30 a minute, burst 60, counting
     * misses. Fetch once per link the user opens; never poll one and never prefetch a body's worth.
     */
    getInvite(id: string): Observable<InviteDto> {
        return this.http.get<InviteDto>(`${this.base}/invites/${id}`);
    }

    redeemInvite(id: string): Observable<RedeemInviteResultDto> {
        return this.http.post<RedeemInviteResultDto>(`${this.base}/invites/${id}/redeem`, {});
    }

    /**
     * Revokes an invite. The row survives - `guildMember.inviteId` points at it - and comes back
     * with `state: "Revoked"` and a `revokedAt`, so the response is worth reading rather than
     * discarding. Idempotent: revoking a revoked invite answers the same body again.
     *
     * <p>Needs `ManageGuild`, or `ManageChannel` on the invite's own `channelId`. An invite with no
     * channel can therefore only be revoked with `ManageGuild`.</p>
     */
    deleteInvite(id: string): Observable<InviteDto> {
        return this.http.delete<InviteDto>(`${this.base}/invites/${id}`);
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
            .get<{channelId: string; userIds: string[]}>(
                `${this.base}/channels/${encodeURIComponent(channelId)}/viewers`,
            )
            .pipe(map(r => r.userIds));
    }

    getMembers(guildId: string, skip: number, take: number): Observable<GuildMemberDto[]> {
        return this.http
            .get<GuildMemberDto[]>(`${this.base}/guilds/${guildId}/members?skip=${skip}&take=${take}`)
            .pipe(tap(members => this.seedProfiles(members)));
    }

    searchMembers(guildId: string, search: string): Observable<GuildMemberDto[]> {
        return this.http
            .get<GuildMemberDto[]>(
                `${this.base}/guilds/${guildId}/members/search?search=${encodeURIComponent(search)}`,
            )
            .pipe(
                tap(members => this.seedProfiles(members)),
                catchError(err => (err.status === 404 ? of([]) : throwError(() => err))),
            );
    }

    /**
     * Hands the embedded profiles on a member list to {@link ProfileService}.
     *
     * <p>Every member row carries a full `ProfileDto` - the server resolves them in one batched call
     * before it answers - and until this existed the client read the name straight off the row and
     * told nobody. So the sidebar's voice roster, a message header and an avatar for those same
     * people each went and fetched a profile the app had already downloaded, one request per user,
     * against a rate limit shared with everything else a launch is doing. There is no bulk profile
     * route to fall back on; this response <i>is</i> the bulk route.</p>
     *
     * <p>Through `hydrateFrom`, so it is one patch rather than one per member - `store` replaces the
     * whole index each time, and a hundred-member list through it would run every avatar and message
     * effect on screen a hundred times. It also leaves a row already fetched this session alone,
     * which is the right way round: that copy is newer than a list assembled server-side.</p>
     */
    private seedProfiles(members: GuildMemberDto[]): void {
        const profiles = members.map(m => m.profile).filter((p): p is ProfileDto => !!p);
        this.profiles.hydrateFrom(profiles);
    }

    /**
     * The signed-in user's member row for a guild - cached, and coalesced while in flight.
     *
     * <p>Callers do not have to know any of that: this still answers with the row, and every one
     * of the ~18 call sites that reads it inside an `effect` is unchanged. What changed is that
     * opening a guild costs one request rather than one per host.</p>
     *
     * <p><b>Everything that could make the cached row wrong invalidates it</b> - see
     * {@link invalidateOwnMember} for the list and for why `OwnMemberRevisionService`, not this
     * service, is what connects `guild.MemberUpdated` to it.</p>
     *
     * <p>A cache hit emits synchronously. Nothing depends on the old asynchrony: every call site
     * only writes signals from its `next`, none of them reads a signal it writes, so no effect can
     * re-enter itself through the shorter path.</p>
     */
    getOwnMember(guildId: string): Observable<SelfGuildMemberDto> {
        const cached = this.ownMemberCache.get(guildId);
        if (cached && Date.now() - cached.at < OWN_MEMBER_TTL_MS) return of(cached.row);

        const existing = this.ownMemberInFlight.get(guildId);
        if (existing) return existing;

        const epoch = this.ownMemberEpoch.get(guildId) ?? 0;
        const shared: Observable<SelfGuildMemberDto> = this.http
            .get<SelfGuildMemberDto>(`${this.base}/guilds/${guildId}/me`)
            .pipe(
                tap(row => {
                    // Answers a question that has since been re-asked. Dropping it costs one
                    // refetch; storing it costs the caller a permission set the server has
                    // already stopped honouring.
                    if ((this.ownMemberEpoch.get(guildId) ?? 0) !== epoch) return;
                    this.ownMemberCache.set(guildId, {row, at: Date.now()});
                }),
                // Identity-checked: an invalidation may already have replaced this entry with a
                // newer request, and this one settling must not take that one down with it.
                finalize(() => {
                    if (this.ownMemberInFlight.get(guildId) === shared)
                        this.ownMemberInFlight.delete(guildId);
                }),
                // `refCount: false` on purpose. With ref counting, a host that is destroyed before
                // the response lands - switching guilds quickly does exactly that - would tear the
                // shared request down and leave its siblings to start fresh ones, which is the
                // duplicate this exists to prevent. The subscription is bounded anyway: an HTTP
                // observable completes after one response.
                shareReplay({bufferSize: 1, refCount: false}),
            );
        this.ownMemberInFlight.set(guildId, shared);
        return shared;
    }

    /**
     * Forgets the cached own-member row so the next {@link getOwnMember} reads it again.
     *
     * <p><b>Called with no id it drops every guild</b>, which is what the role routes need: they
     * are addressed by role id and carry no guild, so there is nothing to narrow the invalidation
     * to. That over-invalidates by at most one refetch per guild whose row is cached, and role
     * edits are rare - guessing wrong in the other direction leaves a user holding a permission
     * the server has revoked.</p>
     *
     * <p><b>What invalidates, and why:</b></p>
     * <ul>
     *   <li>{@link updateMemberPermissions}, {@link kickMember}, {@link kickMemberByUserId},
     *   {@link moveOutMember}, {@link leaveGuild} - each names a member who may be us. A removal
     *   matters even though the UI leaves the guild: rejoining within the TTL would otherwise be
     *   served the roles the removed membership had.</li>
     *   <li>{@link assignRoleToMember}, {@link removeRoleFromMember}, {@link updateRole},
     *   {@link deleteRole} - a role we hold, or now hold, changes what `effectivePermissions`
     *   resolves to.</li>
     *   <li>{@link updateGuild} - `kind` and `features` re-seed the module set, and the resolved
     *   permission mask is clamped to enabled modules, so turning a module off strips bits from a
     *   row whose roles never changed.</li>
     *   <li>{@link deleteGuild} - housekeeping; the row cannot be re-read, but nothing should keep
     *   answering for a guild that is gone.</li>
     *   <li>`guild.MemberUpdated` for our own user, and the events that remove us from a guild or
     *   put us back in one. Those arrive over the realtime socket, which this service deliberately
     *   does not inject - specs provide it an `HttpClient` and nothing else, and pulling the OAuth
     *   client in through the connection would stop every one of them constructing it. So
     *   `OwnMemberRevisionService` listens and calls this; the dependency points that way and must
     *   keep pointing that way.</li>
     * </ul>
     *
     * <p><b>What deliberately does not:</b> {@link createRole} (a role created empty grants nobody
     * anything until somebody is assigned to it, which invalidates in its own right); the channel
     * and category permission overwrites (`effectivePermissions` on this row is the guild-level
     * mask - overwrites are resolved per channel, from data this row does not carry); and a
     * mutation that failed, since the invalidation rides on the response rather than the call.</p>
     */
    invalidateOwnMember(guildId?: string): void {
        if (guildId === undefined) {
            for (const id of new Set([...this.ownMemberCache.keys(), ...this.ownMemberInFlight.keys()])) {
                this.invalidateOwnMember(id);
            }
            return;
        }
        this.ownMemberCache.delete(guildId);
        this.ownMemberInFlight.delete(guildId);
        this.ownMemberEpoch.set(guildId, (this.ownMemberEpoch.get(guildId) ?? 0) + 1);
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    getAuditLog(guildId: string, skip: number, take: number): Observable<AuditLogEntryDto[]> {
        return this.http.get<AuditLogEntryDto[]>(
            `${this.base}/guilds/${guildId}/audit-log?skip=${skip}&take=${take}`,
        );
    }

    reorderRoles(guildId: string, dto: ReorderRolesDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/guilds/${guildId}/roles/reorder`, dto);
    }

    // ── Threads ──────────────────────────────────────────────────────────────
    createThread(channelId: string, dto: CreateThreadDto): Observable<ChannelDto> {
        return this.http.post<ChannelDto>(`${this.base}/channels/${channelId}/threads`, dto);
    }

    /** Started from a specific message. A 409 means the message already has one; the body is `{threadId}`. */
    createThreadFromMessage(
        channelId: string,
        messageId: string,
        dto: CreateThreadDto,
    ): Observable<ChannelDto> {
        return this.http.post<ChannelDto>(
            `${this.base}/channels/${channelId}/messages/${messageId}/threads`,
            dto,
        );
    }

    getThreads(channelId: string): Observable<ChannelDto[]> {
        return this.http.get<ChannelDto[]>(`${this.base}/channels/${channelId}/threads`);
    }

    getChannel(channelId: string): Observable<ChannelDto> {
        return this.http.get<ChannelDto>(`${this.base}/channels/${channelId}`);
    }

    archiveThread(threadId: string): Observable<void> {
        return this.http.patch<void>(`${this.base}/threads/${threadId}/archive`, {});
    }

    getInviteByCode(code: string): Observable<InviteDto> {
        return this.http.get<InviteDto>(`${this.base}/invites/code/${code}`);
    }
}
