import {OnlineStatus} from './profile.dto';
import {Activity} from '../../models/activity.model';

export interface WsMemberBanned {
    guildId: string;
    userId: string;
    reason?: string;
}

export interface WsMemberKicked {
    guildId: string;
    userId: string;
}

/**
 * `guild.MemberMovedOut`, a flatmate was moved out of a household.
 *
 * The only removal a household has: with the Moderation module off there is no kick to fire
 * `guild.MemberKicked` instead. Same envelope, kept as its own event so a member list can say
 * "moved out" rather than "was kicked".
 */
export interface WsMemberMovedOut {
    guildId: string;
    userId: string;
}

export interface WsMemberMuted {
    guildId: string;
    userId: string;
    mutedUntil: string;
}

export interface WsMemberUnmuted {
    guildId: string;
    userId: string;
}

export interface WsMemberLeft {
    guildId: string;
    userId: string;
}

export interface WsMemberJoined {
    guildId: string;
    userId: string;
}

/**
 * A member's roles or nickname changed.
 *
 * `nickname` is the only field the payload carries beyond the ids, and role changes come through
 * here with it unchanged, so the event names who changed, never what. Anything computed from roles
 * has to re-read the member row rather than patch it, and for the signed-in user that means
 * re-reading `GET /guilds/{id}/me`.
 */
export interface WsMemberUpdated {
    guildId: string;
    userId: string;
    nickname: string | null;
}

export interface WsPresenceChanged {
    userId: string;
    guildId: string;
    status: OnlineStatus;
    /**
     * The subject's rich presence, already projected for this viewer.
     *
     * Absent and empty mean different things: `[]` is how the server says a game ended, while
     * `undefined` is a server that has nothing to say on the subject, and only the first should
     * clear anything. {@link UserActivityService.set} draws that line.
     */
    activities?: Activity[];
}
