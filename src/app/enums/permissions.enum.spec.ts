import {describe, expect, it} from 'vitest';
import {
    CHANNEL_PERM_GROUPS,
    diffPermissions,
    hasPermission,
    INERT_PERMISSIONS,
    parsePermissions,
    permissionLabel,
    PERM_GROUPS,
    Permissions,
    PermissionKey,
    stringifyPermissions,
} from './permissions.enum';

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
    it('places every enforced PermissionKey in exactly one group', () => {
        const allKeys = (Object.keys(Permissions) as PermissionKey[])
            .filter(k => k !== 'None' && !INERT_PERMISSIONS.has(k));
        const grouped = PERM_GROUPS.flatMap(g => g.perms);

        for (const key of allKeys) {
            const occurrences = grouped.filter(k => k === key).length;
            expect(occurrences, `${key} should appear in exactly one group`).toBe(1);
        }
        expect(grouped.length).toBe(allKeys.length);
    });

    // They round-trip because they are named bits, not because anything drew a switch for them.
    it('keeps the inert permissions out of the editor', () => {
        const grouped = PERM_GROUPS.flatMap(g => g.perms);

        for (const key of INERT_PERMISSIONS) {
            expect(grouped, `${key} gates nothing and must not be offered`).not.toContain(key);
            expect(stringifyPermissions(Permissions[key])).toBe(key);
        }
    });
});

describe('CHANNEL_PERM_GROUPS', () => {
    const channelKeys = CHANNEL_PERM_GROUPS.flatMap(g => g.perms);

    it('offers no permission twice', () => {
        expect(new Set(channelKeys).size).toBe(channelKeys.length);
    });

    // An overwrite is scoped to one channel; guild-wide authority cannot be granted through it.
    it('leaves guild-scoped authority out', () => {
        const guildScoped: PermissionKey[] = ['Superadmin', 'ManageGuild', 'KickMembers', 'BanMembers',
            'ModerateMembers', 'ViewAuditLog', 'ManageEmojis', 'ManageEvents', 'ManageRoles',
            'ChangeNickname', 'ManageNicknames'];

        for (const key of guildScoped) {
            expect(channelKeys, `${key} is not a channel-scoped grant`).not.toContain(key);
        }
    });

    // The old local copy in permission-override-editor omitted these, so they were unoverridable.
    it('offers the channel-scoped bits that were previously missing', () => {
        for (const key of ['ReadMessageHistory', 'MentionEveryone', 'CreateInvite', 'ManageWebhooks'] as PermissionKey[]) {
            expect(channelKeys).toContain(key);
        }
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

/**
 * These twelve took the positions the wiki and household bits vacated. A number that drifts here
 * does not fail - it reads a stored `ReadMessageHistory` as `ViewWiki` and says nothing.
 */
describe('Discord parity bits', () => {
    const expected: [PermissionKey, number][] = [
        ['ReadMessageHistory', 23], ['SendVoiceMessages', 24], ['SendPolls', 25],
        ['UseExternalEmojis', 26], ['UseExternalStickers', 27], ['CreatePrivateThreads', 28],
        ['UseApplicationCommands', 29], ['CreateExpressions', 30], ['ManageExpressions', 31],
        ['PrioritySpeaker', 39], ['RequestToSpeak', 40], ['UseVoiceActivity', 41],
    ];

    it.each(expected)('puts %s at bit %i', (key, bit) => {
        expect(Permissions[key]).toBe(1n << BigInt(bit));
    });

    it('leaves every other bit exactly where it was', () => {
        expect(Permissions.ViewChannel).toBe(1n << 0n);
        expect(Permissions.CreateInvite).toBe(1n << 22n);
        expect(Permissions.KickMembers).toBe(1n << 32n);
        expect(Permissions.ManageEvents).toBe(1n << 38n);
        expect(Permissions.MentionEveryone).toBe(1n << 50n);
        expect(Permissions.ManageNicknames).toBe(1n << 54n);
        expect(Permissions.Superadmin).toBe(1n << 63n);
    });

    it('round-trips each new name through the serializer', () => {
        for (const [key] of expected) {
            expect(stringifyPermissions(Permissions[key])).toBe(key);
            expect(parsePermissions(key)).toBe(Permissions[key]);
        }
    });

    it('gives every member its own bit', () => {
        const keys = (Object.keys(Permissions) as PermissionKey[]).filter(k => k !== 'None');
        for (const key of keys) {
            for (const other of keys) {
                if (key === other) continue;
                expect(Permissions[key] & Permissions[other], `${key} vs ${other}`).toBe(0n);
            }
        }
    });
});

// The core mask is chat and moderation now. A wiki or household name reaching this table would
// mean the split half-landed, and bit 23 would answer to two different permissions.
describe('the moved names', () => {
    const MOVED = [
        'ViewWiki', 'CreateWikiPages', 'EditOwnWikiPages', 'EditAnyWikiPage', 'DeleteWikiPages',
        'ManageWikiRevisions', 'ManageWikiStructure', 'ModerateWikiComments', 'PublishWikiPublicly',
        'ManageLists', 'AddListItems', 'CheckOffListItems', 'ManageChores', 'CompleteChores',
        'ManageLedger', 'AddExpenses', 'ManagePantry', 'CreateDecisions', 'VoteDecisions',
        'ManageGuests', 'PlanMeals', 'ManageMeals', 'LogMaintenance', 'ManageMaintenance',
    ];

    it.each(MOVED)('no longer defines %s', name => {
        expect(Object.keys(Permissions)).not.toContain(name);
    });

    it('parses a moved name as nothing rather than as some other bit', () => {
        for (const name of MOVED) {
            expect(parsePermissions(name), name).toBe(0n);
        }
    });

    it('leaves no module group behind in the core editor', () => {
        const labels = PERM_GROUPS.map(g => g.label);
        for (const label of ['Wiki', 'Lists', 'Chores', 'Ledger', 'Pantry', 'Decisions', 'Guests', 'Meals', 'Maintenance']) {
            expect(labels).not.toContain(label);
        }
    });

    it('leaves the core groups ungated, so they always render', () => {
        for (const group of PERM_GROUPS) {
            expect(group.feature, `${group.label} is not a module`).toBeUndefined();
        }
    });
});
