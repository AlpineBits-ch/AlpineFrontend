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
