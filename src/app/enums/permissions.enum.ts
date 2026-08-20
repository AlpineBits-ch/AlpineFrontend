import {createFlagCodec, FlagCatalog, FlagGroup, SerializedFlags} from './flag-mask';

/**
 * The core permission mask: what every guild has, whichever modules it switched on.
 * Bit positions are a server storage format: add at a free bit, never move or alias one.
 */
export const Permissions = {
    None: 0n,

    // ── Channel visibility ───────────────────────────────────────────────────
    ViewChannel: 1n << 0n,

    // ── Message permissions ──────────────────────────────────────────────────
    SendMessages: 1n << 1n,
    EditOwnMessages: 1n << 2n,
    EditAnyMessage: 1n << 3n,
    DeleteOwnMessages: 1n << 4n,
    DeleteAnyMessage: 1n << 5n,
    PinMessages: 1n << 6n,

    // ── Attachment / embed permissions ───────────────────────────────────────
    AttachFiles: 1n << 7n,
    EmbedLinks: 1n << 8n,

    // ── Reaction permissions ─────────────────────────────────────────────────
    AddReactions: 1n << 9n,

    // ── Voice / media permissions ────────────────────────────────────────────
    Connect: 1n << 10n,
    Speak: 1n << 11n,
    Stream: 1n << 12n,
    MuteMembers: 1n << 13n,
    DeafenMembers: 1n << 14n,
    MoveMembers: 1n << 15n,

    // ── Thread permissions ───────────────────────────────────────────────────
    /** Discord's CREATE_PUBLIC_THREADS, under its original name; bit 16 is set in stored masks. */
    CreateThreads: 1n << 16n,
    SendMessagesInThreads: 1n << 17n,
    ManageOwnThreads: 1n << 18n,
    ManageAnyThread: 1n << 19n,

    // ── Moderation permissions ───────────────────────────────────────────────
    ManageChannel: 1n << 20n,
    ManagePermissions: 1n << 21n,

    // ── General ──────────────────────────────────────────────────────────────
    CreateInvite: 1n << 22n,

    // ── Discord parity: reading, posting, expressions ────────────────────────
    /** Read the backlog. Distinct from {@link ViewChannel}, which only lists and joins the channel. */
    ReadMessageHistory: 1n << 23n,
    SendVoiceMessages: 1n << 24n,
    SendPolls: 1n << 25n,
    UseExternalEmojis: 1n << 26n,
    UseExternalStickers: 1n << 27n,
    CreatePrivateThreads: 1n << 28n,
    UseApplicationCommands: 1n << 29n,
    /** Upload your own emoji or sticker. The contribute half; {@link ManageExpressions} curates. */
    CreateExpressions: 1n << 30n,
    ManageExpressions: 1n << 31n,

    // ── Moderation (members) ─────────────────────────────────────────────────
    KickMembers: 1n << 32n,
    BanMembers: 1n << 33n,
    ModerateMembers: 1n << 34n,
    ManageGuild: 1n << 35n,
    ViewAuditLog: 1n << 36n,

    // ── Customization ────────────────────────────────────────────────────────
    /** The narrow, original grant that {@link ManageExpressions} supersets. Both are enforced. */
    ManageEmojis: 1n << 37n,
    ManageEvents: 1n << 38n,

    // ── Discord parity: voice ────────────────────────────────────────────────
    PrioritySpeaker: 1n << 39n,
    RequestToSpeak: 1n << 40n,
    UseVoiceActivity: 1n << 41n,

    // ── Mentions ─────────────────────────────────────────────────────────────
    MentionEveryone: 1n << 50n,

    // ── Moderation (split out of coarser bits) ───────────────────────────────
    ManageRoles: 1n << 51n,
    ManageWebhooks: 1n << 52n,

    // ── Nicknames ────────────────────────────────────────────────────────────
    ChangeNickname: 1n << 53n,
    ManageNicknames: 1n << 54n,

    // ── Catch-all ────────────────────────────────────────────────────────────
    Superadmin: 1n << 63n,
} as const;

export type PermissionKey = keyof typeof Permissions;
export type PermissionValue = bigint;

/**
 * Bits the server stores and round-trips but does not act on, because Echo has no feature behind
 * them. Nothing may gate an affordance on one of these.
 */
export const INERT_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
    'SendVoiceMessages',
    'SendPolls',
    'UseExternalStickers',
    'CreatePrivateThreads',
    'PrioritySpeaker',
    'RequestToSpeak',
    'UseVoiceActivity',
]);

export type PermGroup = FlagGroup<PermissionKey>;

export const PERM_GROUPS: PermGroup[] = [
    {
        label: 'General',
        labelKey: 'PERM_GROUP.GENERAL',
        perms: ['ViewChannel', 'CreateInvite', 'ChangeNickname', 'UseApplicationCommands'],
    },
    {
        label: 'Messages',
        labelKey: 'PERM_GROUP.MESSAGES',
        perms: [
            'SendMessages',
            'ReadMessageHistory',
            'EditOwnMessages',
            'EditAnyMessage',
            'DeleteOwnMessages',
            'DeleteAnyMessage',
            'PinMessages',
            'MentionEveryone',
        ],
    },
    {
        label: 'Attachments & Embeds',
        labelKey: 'PERM_GROUP.ATTACHMENTS',
        perms: ['AttachFiles', 'EmbedLinks', 'AddReactions', 'UseExternalEmojis'],
    },
    {
        label: 'Voice',
        labelKey: 'PERM_GROUP.VOICE',
        perms: ['Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers', 'MoveMembers'],
    },
    {
        label: 'Threads',
        labelKey: 'PERM_GROUP.THREADS',
        perms: ['CreateThreads', 'SendMessagesInThreads', 'ManageOwnThreads', 'ManageAnyThread'],
    },
    {
        label: 'Moderation',
        labelKey: 'PERM_GROUP.MODERATION',
        perms: [
            'ManageChannel',
            'ManagePermissions',
            'ManageRoles',
            'ManageWebhooks',
            'ManageGuild',
            'KickMembers',
            'BanMembers',
            'ModerateMembers',
            'ManageNicknames',
            'ViewAuditLog',
        ],
    },
    {
        label: 'Emojis',
        labelKey: 'PERM_GROUP.EMOJIS',
        perms: ['ManageEmojis', 'CreateExpressions', 'ManageExpressions'],
    },
    {
        label: 'Events',
        labelKey: 'PERM_GROUP.EVENTS',
        perms: ['ManageEvents'],
    },
    {
        label: 'Admin',
        labelKey: 'PERM_GROUP.ADMIN',
        perms: ['Superadmin'],
    },
];

export const CORE_PERM_CATALOG: FlagCatalog<PermissionKey> = {
    table: Permissions,
    groups: PERM_GROUPS,
};

/** The subset a per-channel overwrite can express. Guild-scoped authority is left out. */
export const CHANNEL_PERM_GROUPS: PermGroup[] = [
    {
        label: 'General',
        labelKey: 'PERM_GROUP.GENERAL',
        perms: ['ViewChannel', 'CreateInvite', 'UseApplicationCommands'],
    },
    {
        label: 'Messages',
        labelKey: 'PERM_GROUP.MESSAGES',
        perms: [
            'SendMessages',
            'ReadMessageHistory',
            'EditOwnMessages',
            'EditAnyMessage',
            'DeleteOwnMessages',
            'DeleteAnyMessage',
            'PinMessages',
            'MentionEveryone',
        ],
    },
    {
        label: 'Attachments & Embeds',
        labelKey: 'PERM_GROUP.ATTACHMENTS',
        perms: ['AttachFiles', 'EmbedLinks', 'AddReactions', 'UseExternalEmojis'],
    },
    {
        label: 'Voice',
        labelKey: 'PERM_GROUP.VOICE',
        perms: ['Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers', 'MoveMembers'],
    },
    {
        label: 'Threads',
        labelKey: 'PERM_GROUP.THREADS',
        perms: ['CreateThreads', 'SendMessagesInThreads', 'ManageOwnThreads', 'ManageAnyThread'],
    },
    {
        label: 'Moderation',
        labelKey: 'PERM_GROUP.MODERATION',
        perms: ['ManageChannel', 'ManagePermissions', 'ManageWebhooks'],
    },
];

const codec = createFlagCodec(Permissions);

/** @see SerializedFlags; the declared `string` on the DTOs is a hope, not a guarantee. */
export type SerializedPermissions = SerializedFlags;

export const parsePermissions: (serialized: SerializedPermissions) => PermissionValue = codec.parse;
export const parsePermissionCarrier = codec.parseCarrier;
export const stringifyPermissions: (mask: PermissionValue) => string = codec.stringify;
export const stringifyPermissionCarrier = codec.stringifyCarrier;
export const hasPermission: (mask: PermissionValue, permission: PermissionValue) => boolean = codec.has;
export const diffPermissions: (requested: PermissionValue, grantable: PermissionValue) => PermissionKey[] =
    codec.diff;

export function permissionLabel(key: PermissionKey): string {
    return codec.label(key);
}

/**
 * Every "holding X means you also hold Y" rule the server enforces.
 * Mirrors `ImpliedPermissions` in `Guild.Application/Services/GuildPermissionService.cs`.
 * A change here without the matching change there makes the UI lie about what a deny costs.
 */
export const IMPLIED_PERMISSIONS: readonly (readonly [PermissionKey, PermissionKey])[] = [
    ['EditAnyMessage', 'EditOwnMessages'],
    ['DeleteAnyMessage', 'DeleteOwnMessages'],
    ['ManageAnyThread', 'ManageOwnThreads'],
    ['Speak', 'Connect'],
    ['Stream', 'Connect'],
    ['MuteMembers', 'Connect'],
    ['DeafenMembers', 'Connect'],
    ['MoveMembers', 'Connect'],
    ['PinMessages', 'SendMessages'],
    ['AttachFiles', 'SendMessages'],
    ['EmbedLinks', 'SendMessages'],
    ['AddReactions', 'SendMessages'],
    ['CreateThreads', 'SendMessages'],
    ['SendMessages', 'ViewChannel'],
    ['SendMessagesInThreads', 'ViewChannel'],
    ['Connect', 'ViewChannel'],
    ['EditOwnMessages', 'ViewChannel'],
    ['DeleteOwnMessages', 'ViewChannel'],
    ['ManageOwnThreads', 'ViewChannel'],
    ['ManagePermissions', 'ViewChannel'],
    ['ManageChannel', 'ViewChannel'],
];

function closeOver(mask: PermissionValue, edges: readonly (readonly [bigint, bigint])[]): PermissionValue {
    let result = mask;
    let changed = true;
    while (changed) {
        changed = false;
        for (const [from, to] of edges) {
            if ((result & from) === from && (result & to) !== to) {
                result |= to;
                changed = true;
            }
        }
    }
    return result;
}

const REVERSE_EDGES: readonly (readonly [bigint, bigint])[] = IMPLIED_PERMISSIONS.map(
    ([holder, implied]) => [Permissions[implied], Permissions[holder]] as const,
);

/** Widens a deny with everything that implies its bits, so a deny cannot leave a superset behind. */
export function expandDeniedPermissions(mask: PermissionValue): PermissionValue {
    return closeOver(mask, REVERSE_EDGES);
}
