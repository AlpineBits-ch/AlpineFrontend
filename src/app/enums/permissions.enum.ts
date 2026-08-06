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

    // ── Mentions ──────────────────────────────────────────────────────────────
    MentionEveryone: 1n << 50n,

    // ── Moderation (split out of coarser bits) ───────────────────────────────
    ManageRoles: 1n << 51n,
    ManageWebhooks: 1n << 52n,

    // ── Nicknames ─────────────────────────────────────────────────────────────
    ChangeNickname: 1n << 53n,
    ManageNicknames: 1n << 54n,

    // ── Catch-all ────────────────────────────────────────────────────────────
    Superadmin: 1n << 63n,
} as const;

export type PermissionKey = keyof typeof Permissions;
export type PermissionValue = bigint;

export interface PermGroup {
    /** Untranslated identifier for the group - stable across locales, handy in tests. */
    label: string;
    /** The `PERM_GROUP.*` key the UI actually renders. */
    labelKey: string;
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
        labelKey: 'PERM_GROUP.GENERAL',
        perms: ['ViewChannel', 'CreateInvite', 'ChangeNickname'],
    },
    {
        label: 'Messages',
        labelKey: 'PERM_GROUP.MESSAGES',
        perms: ['SendMessages', 'EditOwnMessages', 'EditAnyMessage', 'DeleteOwnMessages', 'DeleteAnyMessage', 'PinMessages', 'MentionEveryone'],
    },
    {
        label: 'Attachments & Embeds',
        labelKey: 'PERM_GROUP.ATTACHMENTS',
        perms: ['AttachFiles', 'EmbedLinks', 'AddReactions'],
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
        perms: ['ManageChannel', 'ManagePermissions', 'ManageRoles', 'ManageWebhooks', 'ManageGuild', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'ViewAuditLog'],
    },
    {
        label: 'Emojis',
        labelKey: 'PERM_GROUP.EMOJIS',
        perms: ['ManageEmojis'],
    },
    {
        label: 'Events',
        labelKey: 'PERM_GROUP.EVENTS',
        perms: ['ManageEvents'],
    },
    {
        label: 'Wiki',
        labelKey: 'PERM_GROUP.WIKI',
        perms: ['ViewWiki', 'CreateWikiPages', 'EditOwnWikiPages', 'EditAnyWikiPage', 'DeleteWikiPages', 'ManageWikiRevisions', 'ManageWikiStructure', 'ModerateWikiComments', 'PublishWikiPublicly'],
    },
    {
        label: 'Lists',
        labelKey: 'PERM_GROUP.LISTS',
        feature: 'Lists',
        perms: ['ManageLists', 'AddListItems', 'CheckOffListItems'],
    },
    {
        label: 'Chores',
        labelKey: 'PERM_GROUP.CHORES',
        feature: 'Chores',
        perms: ['ManageChores', 'CompleteChores'],
    },
    {
        label: 'Ledger',
        labelKey: 'PERM_GROUP.LEDGER',
        feature: 'Ledger',
        perms: ['ManageLedger', 'AddExpenses'],
    },
    {
        label: 'Pantry',
        labelKey: 'PERM_GROUP.PANTRY',
        feature: 'Pantry',
        perms: ['ManagePantry'],
    },
    {
        label: 'Decisions',
        labelKey: 'PERM_GROUP.DECISIONS',
        feature: 'Decisions',
        perms: ['CreateDecisions', 'VoteDecisions'],
    },
    {
        label: 'Guests',
        labelKey: 'PERM_GROUP.GUESTS',
        feature: 'GuestAccess',
        perms: ['ManageGuests'],
    },
    {
        label: 'Admin',
        labelKey: 'PERM_GROUP.ADMIN',
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
 * Every shape the server has been seen to send a permission mask in.
 *
 * <p>The DTOs all type these fields `string`, and that is what .NET emits for a `[Flags]` enum it
 * can name completely. It emits a bare JSON <b>number</b> instead as soon as the value carries a
 * bit with no name - a permission the deployed server knows and this build does not - so the
 * declared type is a hope, not a guarantee, and the parser has to survive both.</p>
 */
export type SerializedPermissions = string | number | bigint | null | undefined;

/**
 * Parses the text-serialized Permissions string (from C# .NET) into a bigint bitmask.
 *
 * <p>Anything it cannot make sense of parses as no permissions rather than throwing: this runs
 * inside permission-gated computed signals, where an exception takes the whole component down
 * instead of merely hiding a control.</p>
 */
export function parsePermissions(serialized: SerializedPermissions): PermissionValue {
    if (!serialized) {
        return 0n;
    }

    // 1. Handle a mask that arrived as a number rather than a name list. Note that a JSON number
    //    cannot carry this enum faithfully past 2^53 - Superadmin sits at bit 63 - so a numeric
    //    payload with high bits set is already rounded by the time JSON.parse hands it over.
    //    Nothing the client can recover; the server has to send names or a string for those.
    if (typeof serialized === 'bigint') {
        return serialized;
    }
    if (typeof serialized === 'number') {
        return Number.isInteger(serialized) ? BigInt(serialized) : 0n;
    }

    // 2. Handle direct numeric representation (e.g., if .NET falls back to a number string)
    if (/^\d+n?$/.test(serialized)) {
        return BigInt(serialized.replace('n', ''));
    }

    // 3. Handle comma-separated string flags (e.g., "ViewChannel, SendMessages")
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