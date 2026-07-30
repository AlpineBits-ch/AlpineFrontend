// Define the TypeScript equivalent of your ulong enum (using number or bigint)
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
    CreateThreads: 1n << 16n,
    SendMessagesInThreads: 1n << 17n,
    ManageOwnThreads: 1n << 18n,
    ManageAnyThread: 1n << 19n,

    // ── Moderation permissions ───────────────────────────────────────────────
    ManageChannel: 1n << 20n,
    ManagePermissions: 1n << 21n,

    // ── Invite permissions ────────────────────────────────────────────────────
    CreateInvite: 1n << 22n,

    // ── Wiki permissions ──────────────────────────────────────────────────────
    ViewWiki: 1n << 23n,
    CreateWikiPages: 1n << 24n,
    EditOwnWikiPages: 1n << 25n,
    EditAnyWikiPage: 1n << 26n,
    DeleteWikiPages: 1n << 27n,
    ManageWikiRevisions: 1n << 28n,
    ManageWikiStructure: 1n << 29n,
    ModerateWikiComments: 1n << 30n,
    PublishWikiPublicly: 1n << 31n,

    // ── Guild moderation permissions ─────────────────────────────────────────
    KickMembers: 1n << 32n,
    BanMembers: 1n << 33n,
    ModerateMembers: 1n << 34n,
    ManageGuild: 1n << 35n,
    ViewAuditLog: 1n << 36n,

    // ── Emoji permissions ─────────────────────────────────────────────────────
    ManageEmojis: 1n << 37n,

    // ── Event permissions ─────────────────────────────────────────────────────
    ManageEvents: 1n << 38n,

    // ── Household: lists ──────────────────────────────────────────────────────
    ManageLists: 1n << 39n,
    AddListItems: 1n << 40n,
    CheckOffListItems: 1n << 41n,

    // ── Household: chores ─────────────────────────────────────────────────────
    ManageChores: 1n << 42n,
    CompleteChores: 1n << 43n,

    // ── Household: ledger ─────────────────────────────────────────────────────
    ManageLedger: 1n << 44n,
    AddExpenses: 1n << 45n,

    // ── Household: pantry ─────────────────────────────────────────────────────
    ManagePantry: 1n << 46n,

    // ── Household: decisions ──────────────────────────────────────────────────
    CreateDecisions: 1n << 47n,
    VoteDecisions: 1n << 48n,

    // ── Household: guest access ───────────────────────────────────────────────
    ManageGuests: 1n << 49n,

    // ── Catch-all ────────────────────────────────────────────────────────────
    Superadmin: 1n << 63n,
} as const;

export type PermissionKey = keyof typeof Permissions;
export type PermissionValue = bigint;

export interface PermGroup {
    label: string;
    perms: PermissionKey[];
    /**
     * The `GuildFeatures` module name gating this group. A plain string rather than the
     * `GuildFeature` union so this file needs no feature-layer import - and the values
     * are the flag names anyway, which is exactly what `GuildFeatureSet` holds.
     *
     * Absent means ungated: the group renders in every guild.
     */
    feature?: string;
}

export const PERM_GROUPS: PermGroup[] = [
    {
        label: 'General',
        perms: ['ViewChannel', 'CreateInvite'],
    },
    {
        label: 'Messages',
        perms: ['SendMessages', 'EditOwnMessages', 'EditAnyMessage', 'DeleteOwnMessages', 'DeleteAnyMessage', 'PinMessages'],
    },
    {
        label: 'Attachments & Embeds',
        perms: ['AttachFiles', 'EmbedLinks', 'AddReactions'],
    },
    {
        label: 'Voice',
        perms: ['Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers', 'MoveMembers'],
    },
    {
        label: 'Threads',
        perms: ['CreateThreads', 'SendMessagesInThreads', 'ManageOwnThreads', 'ManageAnyThread'],
    },
    {
        label: 'Moderation',
        perms: ['ManageChannel', 'ManagePermissions', 'ManageGuild', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog'],
    },
    {
        label: 'Emojis',
        perms: ['ManageEmojis'],
    },
    {
        label: 'Events',
        perms: ['ManageEvents'],
    },
    {
        label: 'Wiki',
        perms: ['ViewWiki', 'CreateWikiPages', 'EditOwnWikiPages', 'EditAnyWikiPage', 'DeleteWikiPages', 'ManageWikiRevisions', 'ManageWikiStructure', 'ModerateWikiComments', 'PublishWikiPublicly'],
    },
    {
        label: 'Lists',
        feature: 'Lists',
        perms: ['ManageLists', 'AddListItems', 'CheckOffListItems'],
    },
    {
        label: 'Chores',
        feature: 'Chores',
        perms: ['ManageChores', 'CompleteChores'],
    },
    {
        label: 'Ledger',
        feature: 'Ledger',
        perms: ['ManageLedger', 'AddExpenses'],
    },
    {
        label: 'Pantry',
        feature: 'Pantry',
        perms: ['ManagePantry'],
    },
    {
        label: 'Decisions',
        feature: 'Decisions',
        perms: ['CreateDecisions', 'VoteDecisions'],
    },
    {
        label: 'Guests',
        feature: 'GuestAccess',
        perms: ['ManageGuests'],
    },
    {
        label: 'Admin',
        perms: ['Superadmin'],
    },
];

export function permissionLabel(key: PermissionKey): string {
    return key.replace(/([A-Z])/g, ' $1').trim();
}

/** Keys present in `requested` but absent from `grantable`. */
export function diffPermissions(requested: PermissionValue, grantable: PermissionValue): PermissionKey[] {
    return (Object.keys(Permissions) as PermissionKey[]).filter(key => {
        if (key === 'None') return false;
        const val = Permissions[key];
        return (requested & val) === val && (grantable & val) !== val;
    });
}

/**
 * Parses the text-serialized Permissions string (from C# .NET) into a bigint bitmask.
 */
export function parsePermissions(serialized: string | null | undefined): PermissionValue {
    if (!serialized) {
        return 0n;
    }

    // 1. Handle direct numeric representation (e.g., if .NET falls back to a number string)
    if (/^\d+n?$/.test(serialized)) {
        return BigInt(serialized.replace('n', ''));
    }

    // 2. Handle comma-separated string flags (e.g., "ViewChannel, SendMessages")
    const parts = serialized.split(',');
    let result: PermissionValue = 0n;

    for (const part of parts) {
        const trimmedKey = part.trim() as PermissionKey;

        if (Permissions[trimmedKey] !== undefined) {
            result |= Permissions[trimmedKey];
        } else {
            // Optional: Handle unknown keys or throw an error based on your strictness needs
            console.warn(`Unknown permission key: ${trimmedKey}`);
        }
    }

    return result;
}

/**
 * Checks if the bitmask includes a specific permission.
 */
export function hasPermission(mask: PermissionValue, permission: PermissionValue): boolean {
    return (mask & permission) === permission;
}

export function stringifyPermissions(mask: PermissionValue): string {
    // 1. Handle the Zero / None case
    if (mask === 0n) {
        return "None";
    }

    const matchedParts: string[] = [];

    // 2. Iterate over all defined permissions and check bits
    for (const [key, value] of Object.entries(Permissions)) {
        // Skip the "None" key when checking active flags
        if (key === "None") continue;

        // Use bitwise AND to check if the flag is present in the mask
        if ((mask & (value as PermissionValue)) === (value as PermissionValue)) {
            matchedParts.push(key);
        }
    }

    // 3. Return as a comma-separated string, or "None" if no flags matched
    return matchedParts.length > 0 ? matchedParts.join(", ") : "None";
}