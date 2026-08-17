import {describe, expect, it} from 'vitest';
import {Permissions, parsePermissions, stringifyPermissions} from './permissions.enum';
import {
    ModulePermissions,
    parseModulePermissions,
    stringifyModulePermissions,
} from './module-permissions.enum';

const coreNames = Object.keys(Permissions).filter(k => k !== 'None');
const moduleNames = Object.keys(ModulePermissions).filter(k => k !== 'None');

/** The two masks are separate 64-bit spaces that overlap numerically and mean different things. */
describe('the two permission spaces', () => {
    it('shares no name between them', () => {
        const shared = coreNames.filter(name => moduleNames.includes(name));

        expect(shared).toEqual([]);
    });

    it('reuses bit numbers for different meanings', () => {
        expect(Permissions.ViewChannel).toBe(ModulePermissions.ViewWiki);
        expect(Permissions.SendMessages).toBe(ModulePermissions.CreateWikiPages);
    });

    // Each parser knows only its own names, so a mask sent to the wrong one comes back empty.
    it('does not resolve a module name against the core table', () => {
        for (const name of moduleNames) {
            expect(parsePermissions(name), name).toBe(0n);
        }
    });

    it('does not resolve a core name against the module table', () => {
        for (const name of coreNames) {
            expect(parseModulePermissions(name), name).toBe(0n);
        }
    });

    it('serializes each space with its own names', () => {
        expect(stringifyPermissions(1n << 0n)).toBe('ViewChannel');
        expect(stringifyModulePermissions(1n << 0n)).toBe('ViewWiki');
    });

    it('keeps Superadmin in the core mask alone', () => {
        expect(coreNames).toContain('Superadmin');
        expect(moduleNames).not.toContain('Superadmin');
    });
});
