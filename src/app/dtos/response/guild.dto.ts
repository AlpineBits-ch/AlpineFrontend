import {GuildVerificationLevel} from './guild-safety.dto';

export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
    Forum = 'Forum',
    /** A forum variant: same tags, posts and endpoints, gallery-first rendering. */
    Media = 'Media',
    Announcement = 'Announcement',

    // ── Household channel types ─────────────────────────────────────────────
    // Structured rows, not messages: none of these has message history or a
    // composer. Each is gated on the matching GuildFeatures module - see
    // features/guild/channel-types.ts.
    List = 'List',
    Chores = 'Chores',
    Ledger = 'Ledger',
    Pantry = 'Pantry',
    Decisions = 'Decisions',
    Meals = 'Meals',
    Maintenance = 'Maintenance',
}

/** Forum and Media behave identically everywhere except how their post list is drawn. */
export function isForumLike(type: ChannelType): boolean {
    return type === ChannelType.Forum || type === ChannelType.Media;
}

export interface ChannelDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    type: ChannelType;
    guildId: string;
    isAgeRestricted: boolean;
    isPrivate: boolean;
    categoryId: string | undefined;
    permissions: ChannelPermission[];
    position: number;
    slowModeSeconds: number;
    parentChannelId: string | undefined;

    // ── Thread-only, additive. Absent on non-thread channels and on threads
    // created before the forum-parity deploy. ───────────────────────────────
    createdByUserId?: string;
    tagIds?: string[];
    isPinned?: boolean;
    isLocked?: boolean;
    isArchived?: boolean;
    /** Absent until someone posts in the thread; fall back to createdAt for sorting. */
    lastActivityAt?: string;
    messageCount?: number;
    autoArchiveAt?: string;
    autoArchiveMinutes?: number;
}

export interface ChannelPermission {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    channelId: string | undefined;
    roleId: string | undefined;
    memberId: string | undefined;
    categoryId: string | undefined;
    allowPermissions: string;
    denyPermissions: string;
    /**
     * The module half of the overwrite. Absent on the flat shape nested in guild payloads, which
     * is why these are optional - and unwritable either way, see `OverridePermissionsDto`.
     */
    allowModulePermissions?: string;
    denyModulePermissions?: string;
}

export interface RoleDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    color: string;
    guildId: string;
    userId: string;
    permissions: string;
    type: RoleType;
    position: number;

    /**
     * Wiki and household bits, in their own 64-bit space. Never OR this with `permissions`: bit 0
     * is `ViewChannel` there and `ViewWiki` here.
     *
     * <p>Absent on the flat role shape reached through `SelfGuildMemberDto.roleMembers`, so a
     * union over module bits has to resolve the role out of `guild.roles` instead.</p>
     */
    modulePermissions?: string;

    /** Show this role's members as their own section of the member list. */
    hoist?: boolean;

    /**
     * Whether anyone may ping this role. **Absent means true** - the server's default - and
     * reading an absent field as false silently makes every role unmentionable.
     */
    mentionable?: boolean;

    /** Role badge. Mutually exclusive with {@link unicodeEmoji}. */
    iconUrl?: string | null;
    unicodeEmoji?: string | null;

    /** Owned by a bot or integration: the server refuses every edit and delete with a 400. */
    isManaged?: boolean;
    botUserId?: string | null;
    integrationId?: string | null;
}

export interface CategoryDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    permissions: ChannelPermission[];
    position: number;
}


/**
 * What a guild *is*. Presentation only - it picks nomenclature ("House" vs "Server")
 * and which settings surfaces make sense. It never gates anything: that is what
 * `GuildDto.features` is for.
 */
export enum GuildKind {
    Community = 'Community',
    Household = 'Household',
    Team = 'Team',
    Study = 'Study',
    Event = 'Event',
}

export interface GuildDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    ownerId: string;
    categories: CategoryDto[];
    channels: ChannelDto[];
    roles: RoleDto[];
    bannerUrl?: string;
    systemChannelId: string | null;
    verificationLevel?: GuildVerificationLevel;

    /** Absent on payloads that predate the modules layer - treat as {@link GuildKind.Community}. */
    kind?: GuildKind;
    /**
     * Comma-separated flag *names* ("VoiceChannels, Threads"), or "None" - never a
     * bitmask. Absent means an older backend, which is every-community-module-on;
     * see `parseGuildFeatures` in features/guild/guild-features.ts.
     */
    features?: string;
}

export enum RoleType {
    None = 'None',
    Everyone = 'Everyone',
}