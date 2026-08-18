import {createFlagCodec, FlagCatalog, FlagGroup} from './flag-mask';

/**
 * The permission bits owned by an optional guild module: the wiki and the household features.
 * A separate 64-bit space that overlaps {@link Permissions} numerically, so the two are never OR'd
 * together and never share a parser. Bit positions mirror `Guild.Domain/Enums/ModulePermissions.cs`:
 * add at bit 24 or above, and never move an existing member.
 */
export const ModulePermissions = {
    None: 0n,

    ViewWiki: 1n << 0n,
    CreateWikiPages: 1n << 1n,
    EditOwnWikiPages: 1n << 2n,
    EditAnyWikiPage: 1n << 3n,
    DeleteWikiPages: 1n << 4n,
    ManageWikiRevisions: 1n << 5n,
    ManageWikiStructure: 1n << 6n,
    ModerateWikiComments: 1n << 7n,
    PublishWikiPublicly: 1n << 8n,

    ManageLists: 1n << 9n,
    AddListItems: 1n << 10n,
    CheckOffListItems: 1n << 11n,
    ManageChores: 1n << 12n,
    CompleteChores: 1n << 13n,
    ManageLedger: 1n << 14n,
    AddExpenses: 1n << 15n,
    ManagePantry: 1n << 16n,
    CreateDecisions: 1n << 17n,
    VoteDecisions: 1n << 18n,
    ManageGuests: 1n << 19n,

    PlanMeals: 1n << 20n,
    ManageMeals: 1n << 21n,
    LogMaintenance: 1n << 22n,
    ManageMaintenance: 1n << 23n,

    UsePersonas: 1n << 24n,
    ManageAnyPersona: 1n << 25n,
    ApprovePersonas: 1n << 26n,
    ManageScenes: 1n << 27n,
    RollDice: 1n << 28n,
} as const;

export type ModulePermissionKey = Exclude<keyof typeof ModulePermissions, 'None'>;
export type ModulePermissionValue = bigint;

export const moduleCodec = createFlagCodec(ModulePermissions);

export const parseModulePermissions = moduleCodec.parse;
export const parseModulePermissionCarrier = moduleCodec.parseCarrier;
export const stringifyModulePermissions = moduleCodec.stringify;
export const stringifyModulePermissionCarrier = moduleCodec.stringifyCarrier;
export const hasModulePermission = moduleCodec.has;

/**
 * The module each bit belongs to. A guild with the module off resolves the bit as unset for
 * everybody, owner and Superadmin included, so this is a clamp and not just a UI hint.
 */
export const MODULE_PERM_FEATURE: Readonly<Record<ModulePermissionKey, string>> = {
    ViewWiki: 'Wiki',
    CreateWikiPages: 'Wiki',
    EditOwnWikiPages: 'Wiki',
    EditAnyWikiPage: 'Wiki',
    DeleteWikiPages: 'Wiki',
    ManageWikiRevisions: 'Wiki',
    ManageWikiStructure: 'Wiki',
    ModerateWikiComments: 'Wiki',
    PublishWikiPublicly: 'Wiki',

    ManageLists: 'Lists',
    AddListItems: 'Lists',
    CheckOffListItems: 'Lists',
    ManageChores: 'Chores',
    CompleteChores: 'Chores',
    ManageLedger: 'Ledger',
    AddExpenses: 'Ledger',
    ManagePantry: 'Pantry',
    CreateDecisions: 'Decisions',
    VoteDecisions: 'Decisions',
    ManageGuests: 'GuestAccess',

    PlanMeals: 'Meals',
    ManageMeals: 'Meals',
    LogMaintenance: 'Maintenance',
    ManageMaintenance: 'Maintenance',

    UsePersonas: 'Personas',
    ManageAnyPersona: 'Personas',
    ApprovePersonas: 'Personas',
    ManageScenes: 'Scenes',
    RollDice: 'Dice',
};

const FEATURE_BY_BIT: readonly (readonly [bigint, string])[] = (
    Object.keys(MODULE_PERM_FEATURE) as ModulePermissionKey[]
).map(key => [ModulePermissions[key], MODULE_PERM_FEATURE[key]] as const);

/** The modules a mask depends on, all of which must be enabled for it to resolve. */
export function modulePermissionFeatures(mask: ModulePermissionValue): string[] {
    return FEATURE_BY_BIT.filter(([bit]) => (mask & bit) === bit).map(([, feature]) => feature);
}

export const MODULE_PERM_GROUPS: readonly FlagGroup<ModulePermissionKey>[] = [
    {
        label: 'Wiki',
        labelKey: 'PERM_GROUP.WIKI',
        feature: 'Wiki',
        perms: [
            'ViewWiki',
            'CreateWikiPages',
            'EditOwnWikiPages',
            'EditAnyWikiPage',
            'DeleteWikiPages',
            'ManageWikiRevisions',
            'ManageWikiStructure',
            'ModerateWikiComments',
            'PublishWikiPublicly',
        ],
    },
    {
        label: 'Characters',
        labelKey: 'PERM_GROUP.PERSONAS',
        feature: 'Personas',
        perms: ['UsePersonas', 'ManageAnyPersona', 'ApprovePersonas'],
    },
    {
        label: 'Scenes',
        labelKey: 'PERM_GROUP.SCENES',
        feature: 'Scenes',
        perms: ['ManageScenes'],
    },
    {
        label: 'Dice',
        labelKey: 'PERM_GROUP.DICE',
        feature: 'Dice',
        perms: ['RollDice'],
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
        label: 'Meals',
        labelKey: 'PERM_GROUP.MEALS',
        feature: 'Meals',
        perms: ['PlanMeals', 'ManageMeals'],
    },
    {
        label: 'Maintenance',
        labelKey: 'PERM_GROUP.MAINTENANCE',
        feature: 'Maintenance',
        perms: ['LogMaintenance', 'ManageMaintenance'],
    },
];

export const MODULE_PERM_CATALOG: FlagCatalog<ModulePermissionKey> = {
    table: ModulePermissions,
    groups: MODULE_PERM_GROUPS,
};
