import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../../../enums/member-type.enum';
import {
    INVITE_CANDIDATE_LIMIT,
    InviteCandidateInput,
    pickInviteCandidates,
} from './channel-invite-candidates.util';

function member(over: Partial<GuildMemberDto> & {userId: string}): GuildMemberDto {
    return {
        id: `mem_${over.userId}`,
        guildId: 'g1',
        inviteId: '',
        status: OnlineStatus.Online,
        type: MemberType.Default,
        nickname: null,
        profile: {userName: over.userId} as GuildMemberDto['profile'],
        readState: [],
        ...over,
    } as GuildMemberDto;
}

/** Everybody named can see the channel, nobody is in it, and nobody is a friend. */
function input(over: Partial<InviteCandidateInput> & {members: GuildMemberDto[]}): InviteCandidateInput {
    return {
        viewers: over.members.map(m => m.userId),
        friendIds: new Set<string>(),
        alreadyIn: [],
        selfUserId: 'me',
        ...over,
    };
}

describe('pickInviteCandidates', () => {
    it('puts friends above everybody else', () => {
        const picked = pickInviteCandidates(
            input({
                members: [member({userId: 'aaron'}), member({userId: 'zoe'})],
                friendIds: new Set(['zoe']),
            }),
        );

        expect(picked.map(c => c.userId)).toEqual(['zoe', 'aaron']);
    });

    it('offers an offline friend, and never an offline stranger', () => {
        const picked = pickInviteCandidates(
            input({
                members: [
                    member({userId: 'friend', status: OnlineStatus.Offline}),
                    member({userId: 'stranger', status: OnlineStatus.Offline}),
                ],
                friendIds: new Set(['friend']),
            }),
        );

        expect(picked.map(c => c.userId)).toEqual(['friend']);
    });

    it('reads Hidden as offline, because that is what it was chosen for', () => {
        const picked = pickInviteCandidates(
            input({
                members: [member({userId: 'lurker', status: OnlineStatus.Hidden})],
            }),
        );

        expect(picked).toEqual([]);
    });

    it('counts Idle and DoNotDisturb as around', () => {
        const picked = pickInviteCandidates(
            input({
                members: [
                    member({userId: 'idle', status: OnlineStatus.Idle}),
                    member({userId: 'busy', status: OnlineStatus.DoNotDisturb}),
                ],
            }),
        );

        expect(picked.map(c => c.userId)).toEqual(['busy', 'idle']);
    });

    it('orders an online friend above an offline one', () => {
        const picked = pickInviteCandidates(
            input({
                members: [
                    member({userId: 'away', status: OnlineStatus.Offline}),
                    member({userId: 'here', status: OnlineStatus.Online}),
                ],
                friendIds: new Set(['away', 'here']),
            }),
        );

        expect(picked.map(c => c.userId)).toEqual(['here', 'away']);
    });

    it('drops yourself, anybody already in the room, and anybody who cannot see the channel', () => {
        const members = [
            member({userId: 'me'}),
            member({userId: 'inside'}),
            member({userId: 'blind'}),
            member({userId: 'ada'}),
        ];

        const picked = pickInviteCandidates(
            input({
                members,
                viewers: ['me', 'inside', 'ada'],
                alreadyIn: ['inside'],
            }),
        );

        expect(picked.map(c => c.userId)).toEqual(['ada']);
    });

    it('offers nobody when the viewer read came back empty', () => {
        const picked = pickInviteCandidates(
            input({
                members: [member({userId: 'ada'})],
                viewers: [],
            }),
        );

        expect(picked).toEqual([]);
    });

    it('drops bots, which can neither sit in a channel nor read a message', () => {
        const picked = pickInviteCandidates(
            input({
                members: [member({userId: 'helper', type: MemberType.Bot})],
                friendIds: new Set(['helper']),
            }),
        );

        expect(picked).toEqual([]);
    });

    it('stops at five', () => {
        const picked = pickInviteCandidates(
            input({
                members: Array.from({length: 9}, (_, i) => member({userId: `user${i}`})),
            }),
        );

        expect(picked.length).toBe(INVITE_CANDIDATE_LIMIT);
    });

    it('prefers the nickname, then the username', () => {
        const picked = pickInviteCandidates(
            input({
                members: [member({userId: 'u1', nickname: 'Ada'}), member({userId: 'u2', nickname: null})],
            }),
        );

        expect(picked.map(c => c.name)).toEqual(['Ada', 'u2']);
    });
});
