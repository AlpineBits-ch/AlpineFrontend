import {describe, expect, it} from 'vitest';
import en from '../../assets/i18n/locales/en.json';
import {
    MODULE_PERM_FEATURE,
    MODULE_PERM_GROUPS,
    ModulePermissionKey,
    ModulePermissions,
    parseModulePermissions,
    stringifyModulePermissions,
} from './module-permissions.enum';
import {GuildFeature} from '../features/guild/guild-features';

const keys = Object.keys(ModulePermissions).filter(k => k !== 'None') as ModulePermissionKey[];

/** The bit numbers are the contract with `Guild.Domain/Enums/ModulePermissions.cs`. */
describe('ModulePermissions bit positions', () => {
    const expected: Record<string, number> = {
        ViewWiki: 0,
        CreateWikiPages: 1,
        EditOwnWikiPages: 2,
        EditAnyWikiPage: 3,
        DeleteWikiPages: 4,
        ManageWikiRevisions: 5,
        ManageWikiStructure: 6,
        ModerateWikiComments: 7,
        PublishWikiPublicly: 8,
        ManageLists: 9,
        AddListItems: 10,
        CheckOffListItems: 11,
        ManageChores: 12,
        CompleteChores: 13,
        ManageLedger: 14,
        AddExpenses: 15,
        ManagePantry: 16,
        CreateDecisions: 17,
        VoteDecisions: 18,
        ManageGuests: 19,
        PlanMeals: 20,
        ManageMeals: 21,
        LogMaintenance: 22,
        ManageMaintenance: 23,
    };

    it.each(Object.entries(expected))('puts %s at bit %i', (key, bit) => {
        expect(ModulePermissions[key as ModulePermissionKey]).toBe(1n << BigInt(bit));
    });

    it('defines exactly the members the backend does', () => {
        expect(keys.sort()).toEqual(Object.keys(expected).sort());
    });

    it('gives every member its own bit', () => {
        for (const key of keys) {
            for (const other of keys) {
                if (key === other) continue;
                expect(ModulePermissions[key] & ModulePermissions[other]).toBe(0n);
            }
        }
    });

    it('has no Superadmin - authority lives in the core mask', () => {
        expect(Object.keys(ModulePermissions)).not.toContain('Superadmin');
    });
});

describe('module permission serialization', () => {
    it('round-trips a mask through names', () => {
        const mask = ModulePermissions.ViewWiki | ModulePermissions.CompleteChores;

        expect(stringifyModulePermissions(mask)).toBe('ViewWiki, CompleteChores');
        expect(parseModulePermissions('ViewWiki, CompleteChores')).toBe(mask);
    });

    // Bit 0 is ViewWiki here and ViewChannel in the core mask. Nothing may OR the two together.
    it('reads bit 0 as ViewWiki', () => {
        expect(parseModulePermissions('1')).toBe(ModulePermissions.ViewWiki);
    });
});

describe('MODULE_PERM_FEATURE', () => {
    const features = new Set<string>(Object.values(GuildFeature));

    it('names a real module for every permission', () => {
        for (const key of keys) {
            expect(features).toContain(MODULE_PERM_FEATURE[key]);
        }
    });

    it('covers every permission', () => {
        expect(Object.keys(MODULE_PERM_FEATURE).sort()).toEqual(keys.sort());
    });
});

describe('MODULE_PERM_GROUPS', () => {
    it('offers every permission exactly once', () => {
        const grouped = MODULE_PERM_GROUPS.flatMap(g => g.perms);

        expect(grouped.sort()).toEqual(keys.sort());
    });

    it('gates each group on the module its permissions belong to', () => {
        for (const group of MODULE_PERM_GROUPS) {
            for (const key of group.perms) {
                expect(group.feature).toBe(MODULE_PERM_FEATURE[key]);
            }
        }
    });

    // The label is resolved dynamically in the template, so the app-wide key sweep cannot see it.
    it('uses a label key that exists in en.json', () => {
        for (const group of MODULE_PERM_GROUPS) {
            expect(en, `missing ${group.labelKey}`).toHaveProperty(group.labelKey);
        }
    });
});
