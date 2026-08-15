import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../../../enums/member-type.enum';

/** One name the panel offers. */
export interface InviteCandidate {
    userId: string;
    name: string;
    /** A friend of yours who is also a member here. Ordered first, and the row says so. */
    isFriend: boolean;
    online: boolean;
}

export interface InviteCandidateInput {
    members: readonly GuildMemberDto[];
    /**
     * Who the server says can see the channel. An empty list is read as "we could not find out"
     * and offers nobody, which is the same collapse {@link VoiceRingPickerComponent} makes.
     */
    viewers: readonly string[];
    friendIds: ReadonlySet<string>;
    /** Already in the room. A ring at them answers `409`, so offering them is offering nothing. */
    alreadyIn: readonly string[];
    selfUserId: string;
    limit?: number;
}

/**
 * Five, because this is the shortcut and not the member list.
 *
 * <p>A sixth name would be another row to read before deciding nobody here is who you meant, and
 * the person who wants somebody specific is already reaching for Search everyone.</p>
 */
export const INVITE_CANDIDATE_LIMIT = 5;

/**
 * Who to offer in the quick invite panel, in the order they are offered.
 *
 * <p><b>Friends first, whether or not they are online.</b> A friend who is offline is still the
 * person you meant - the invitation goes in their conversation and stands there until they read it,
 * so "not right now" is not the same answer it would be for a ring. Everybody else has to be online
 * to earn a slot: a stranger who has not been seen in a week is not who anybody is trying to pull
 * into a voice channel, and there is no last-active timestamp on a member to make a better guess
 * with.</p>
 *
 * <p><b>Bots are dropped.</b> They cannot be in a voice channel and cannot read a direct message,
 * so both halves of what this panel does are no-ops for them.</p>
 *
 * <p>The three exclusions - yourself, whoever is already in the room, and anybody who cannot see the
 * channel - are the ones the server would refuse, and the last of them is not refunded against the
 * ring budget. Filtering here is what stops this panel spending that budget to discover who can see
 * a private channel.</p>
 */
export function pickInviteCandidates(input: InviteCandidateInput): InviteCandidate[] {
    const canSee = new Set(input.viewers);
    const excluded = new Set([...input.alreadyIn, input.selfUserId]);

    const candidates = input.members
        .filter(m => m.type !== MemberType.Bot)
        .filter(m => !excluded.has(m.userId))
        .filter(m => canSee.has(m.userId))
        .map(m => ({
            userId: m.userId,
            name: m.nickname || m.profile?.userName || m.userId,
            isFriend: input.friendIds.has(m.userId),
            online: isActive(m.status),
        }))
        .filter(c => c.isFriend || c.online);

    return candidates
        .sort(byPriority)
        .slice(0, input.limit ?? INVITE_CANDIDATE_LIMIT);
}

/** Present in some form. `Hidden` is somebody who asked to read as offline, and is taken at their word. */
function isActive(status: OnlineStatus): boolean {
    return status !== OnlineStatus.Offline && status !== OnlineStatus.Hidden;
}

/** Friends, then presence, then the alphabet - each tie broken by the next. */
function byPriority(a: InviteCandidate, b: InviteCandidate): number {
    if (a.isFriend !== b.isFriend) return a.isFriend ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
}
