import {describe, expect, it} from 'vitest';
import {diffPermissions, hasPermission, parsePermissions, permissionLabel, PERM_GROUPS, Permissions, PermissionKey, stringifyPermissions} from './permissions.enum';

describe('Permissions moderation bits', () => {
    it('defines KickMembers at bit 32', () => {
        expect(Permissions.KickMembers).toBe(1n << 32n);
    });

    it('defines BanMembers at bit 33', () => {
        expect(Permissions.BanMembers).toBe(1n << 33n);
    });

    it('defines ModerateMembers at bit 34', () => {
        expect(Permissions.ModerateMembers).toBe(1n << 34n);
    });

    it('defines ManageGuild at bit 35', () => {
        expect(Permissions.ManageGuild).toBe(1n << 35n);
    });

    it('defines ViewAuditLog at bit 36', () => {
        expect(Permissions.ViewAuditLog).toBe(1n << 36n);
    });

    it('defines ManageEmojis at bit 37', () => {
        expect(Permissions.ManageEmojis).toBe(1n << 37n);
    });

    it('exposes ManageEvents at bit 38, matching the backend enum', () => {
        expect(Permissions.ManageEvents).toBe(1n << 38n);
    });

    it('round-trips ManageEvents through the serializer', () => {
        expect(stringifyPermissions(Permissions.ManageEvents)).toBe('ManageEvents');
        expect(parsePermissions('ManageEvents')).toBe(Permissions.ManageEvents);
    });

    it('does not collide with any existing bit (0-31, 63)', () => {
        const newBits: PermissionKey[] = ['KickMembers', 'BanMembers', 'ModerateMembers', 'ManageGuild', 'ViewAuditLog'];
        const existingKeys = (Object.keys(Permissions) as PermissionKey[])
            .filter(k => !newBits.includes(k) && k !== 'None');
        for (const newKey of newBits) {
            for (const existingKey of existingKeys) {
                expect(Permissions[newKey] & Permissions[existingKey]).toBe(0n);
            }
        }
    });

    it('stringifyPermissions round-trips a mask containing BanMembers', () => {
        const mask = Permissions.ViewChannel | Permissions.BanMembers;
        const serialized = stringifyPermissions(mask);
        expect(serialized).toContain('BanMembers');
        expect(hasPermission(mask, Permissions.BanMembers)).toBe(true);
    });
});

// The wire value is not always a string. .NET writes a [Flags] enum as a bare JSON number
// whenever the value carries a bit it has no name for, so `permissions`/`effectivePermissions`
// arrive as numbers on some payloads even though every DTO types them `string`.
describe('parsePermissions wire types', () => {
    it('accepts a JSON number mask', () => {
        expect(parsePermissions(Number(Permissions.ManageGuild) as unknown as string))
            .toBe(Permissions.ManageGuild);
    });

    it('accepts a numeric mask carrying several bits', () => {
        const mask = Permissions.ViewChannel | Permissions.SendMessages | Permissions.ManageGuild;
        expect(parsePermissions(Number(mask) as unknown as string)).toBe(mask);
    });

    it('reads numeric zero as no permissions', () => {
        expect(parsePermissions(0 as unknown as string)).toBe(0n);
    });

    it('accepts a bigint mask unchanged', () => {
        expect(parsePermissions(Permissions.Superadmin as unknown as string)).toBe(Permissions.Superadmin);
    });

    it('grants nothing for a numeric value that is not a whole mask', () => {
        expect(parsePermissions(Number.NaN as unknown as string)).toBe(0n);
        expect(parsePermissions(1.5 as unknown as string)).toBe(0n);
    });

    it('still reads a digit string and a name list', () => {
        expect(parsePermissions(Permissions.ManageGuild.toString())).toBe(Permissions.ManageGuild);
        expect(parsePermissions('ViewChannel, SendMessages'))
            .toBe(Permissions.ViewChannel | Permissions.SendMessages);
    });
});

describe('PERM_GROUPS', () => {
    it('places every PermissionKey except None in exactly one group', () => {
        const allKeys = (Object.keys(Permissions) as PermissionKey[]).filter(k => k !== 'None');
        const grouped = PERM_GROUPS.flatMap(g => g.perms);

        for (const key of allKeys) {
            const occurrences = grouped.filter(k => k === key).length;
            expect(occurrences, `${key} should appear in exactly one group`).toBe(1);
        }
        expect(grouped.length).toBe(allKeys.length);
    });
});

describe('permissionLabel', () => {
    it('inserts spaces before capital letters', () => {
        expect(permissionLabel('SendMessages')).toBe('Send Messages');
    });

    it('leaves a single-word key unchanged', () => {
        expect(permissionLabel('Connect')).toBe('Connect');
    });
});

describe('diffPermissions', () => {
    it('returns keys present in requested but not in grantable', () => {
        const requested = Permissions.ViewChannel | Permissions.BanMembers;
        const grantable = Permissions.ViewChannel;
        expect(diffPermissions(requested, grantable)).toEqual(['BanMembers']);
    });

    it('returns an empty array when grantable covers all of requested', () => {
        const requested = Permissions.ViewChannel;
        const grantable = Permissions.ViewChannel | Permissions.BanMembers;
        expect(diffPermissions(requested, grantable)).toEqual([]);
    });

    it('returns an empty array for equal masks', () => {
        const mask = Permissions.SendMessages | Permissions.Connect;
        expect(diffPermissions(mask, mask)).toEqual([]);
    });
});

describe('Household permission bits', () => {
    const HOUSEHOLD_KEYS: PermissionKey[] = [
        'ManageLists', 'AddListItems', 'CheckOffListItems',
        'ManageChores', 'CompleteChores',
        'ManageLedger', 'AddExpenses',
        'ManagePantry',
        'CreateDecisions', 'VoteDecisions',
        'ManageGuests',
    ];

    it('assigns bits 39-49 in the order the backend guide lists them', () => {
        HOUSEHOLD_KEYS.forEach((key, i) => {
            expect(Permissions[key], key).toBe(1n << BigInt(39 + i));
        });
    });

    it('does not collide with any pre-existing bit', () => {
        const existing = (Object.keys(Permissions) as PermissionKey[])
            .filter(k => k !== 'None' && !HOUSEHOLD_KEYS.includes(k));
        for (const key of HOUSEHOLD_KEYS) {
            for (const other of existing) {
                expect(Permissions[key] & Permissions[other], `${key} vs ${other}`).toBe(0n);
            }
        }
    });

    // The wire format is names in both directions, so a name that does not round-trip
    // is a permission the client would silently drop when saving a role.
    it('round-trips every household name through the serializer', () => {
        for (const key of HOUSEHOLD_KEYS) {
            expect(stringifyPermissions(Permissions[key])).toBe(key);
            expect(parsePermissions(key)).toBe(Permissions[key]);
        }
    });

    it('tags each household group with the module that gates it', () => {
        const byLabel = new Map(PERM_GROUPS.map(g => [g.label, g]));
        expect(byLabel.get('Lists')?.feature).toBe('Lists');
        expect(byLabel.get('Chores')?.feature).toBe('Chores');
        expect(byLabel.get('Ledger')?.feature).toBe('Ledger');
        expect(byLabel.get('Pantry')?.feature).toBe('Pantry');
        expect(byLabel.get('Decisions')?.feature).toBe('Decisions');
        expect(byLabel.get('Guests')?.feature).toBe('GuestAccess');
    });

    it('leaves the chat groups untagged, so they always render', () => {
        const byLabel = new Map(PERM_GROUPS.map(g => [g.label, g]));
        expect(byLabel.get('General')?.feature).toBeUndefined();
        expect(byLabel.get('Messages')?.feature).toBeUndefined();
        expect(byLabel.get('Admin')?.feature).toBeUndefined();
    });
});
