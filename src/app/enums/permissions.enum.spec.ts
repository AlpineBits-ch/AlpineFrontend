import {describe, expect, it} from 'vitest';
import {hasPermission, Permissions, PermissionKey, stringifyPermissions} from './permissions.enum';

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
