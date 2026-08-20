import {
    expandDeniedPermissions,
    expandImpliedPermissions,
    IMPLIED_PERMISSIONS,
    Permissions,
} from './permissions.enum';

// Mirrors Guild.Application/Services/GuildPermissionService.cs ImpliedPermissions.
// See docs/specs/channel-permissions-ux.md, "Golden list".
const GOLDEN: ReadonlyArray<readonly [keyof typeof Permissions, keyof typeof Permissions]> = [
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

describe('implication table', () => {
    it('matches the golden list exactly', () => {
        expect([...IMPLIED_PERMISSIONS]).toEqual([...GOLDEN]);
    });

    it('closes a grant forwards', () => {
        for (const [holder, implied] of GOLDEN) {
            const expanded = expandImpliedPermissions(Permissions[holder]);
            expect(expanded & Permissions[implied]).toBe(Permissions[implied]);
        }
    });

    it('closes a deny backwards', () => {
        for (const [holder, implied] of GOLDEN) {
            const expanded = expandDeniedPermissions(Permissions[implied]);
            expect(expanded & Permissions[holder]).toBe(Permissions[holder]);
        }
    });

    it('carries a deny transitively', () => {
        // AttachFiles implies SendMessages implies ViewChannel, so denying ViewChannel takes both.
        const expanded = expandDeniedPermissions(Permissions.ViewChannel);

        expect(expanded & Permissions.SendMessages).toBe(Permissions.SendMessages);
        expect(expanded & Permissions.AttachFiles).toBe(Permissions.AttachFiles);
    });

    it('leaves an unrelated bit alone', () => {
        expect(expandDeniedPermissions(Permissions.ManageEvents)).toBe(Permissions.ManageEvents);
    });
});
