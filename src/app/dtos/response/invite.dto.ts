import {GuildDto} from './guild.dto';
import {WelcomeScreen} from './guild-safety.dto';

export enum InviteType {
    OneTime = 'OneTime',
    Permanent = 'Permanent',
}

/**
 * The lifecycle of an invite, as the server derives it on every read.
 *
 * <p><b>Never re-derive this.</b> The server computes it per request from the revocation, the
 * expiry, the use count and - for a one-time invite - whether it has been consumed, which is a fact
 * only it holds. A local `expiresAt < now` check used to paper over a server that never wrote
 * `Expired`; keeping one now is a second source of truth that disagrees on exactly the case it
 * cannot see.</p>
 */
export enum InviteState {
    Active = 'Active',
    /** Ran out on its own: past `expiresAt`, out of uses, or a consumed one-time invite. */
    Expired = 'Expired',
    /** Taken away by a moderator. Terminal, and a different thing from expiry. */
    Revoked = 'Revoked',
}

/**
 * `state` on the wire.
 *
 * <p>Widened past the enum on purpose: `Revoked` arrived as a new value on an existing field, and
 * the next one will too. A union of literals would make an unrecognised value a type error at the
 * point of use and - worse - invite a `switch` with no default. Every consumer here tests for the
 * states it knows and treats anything else as "not one of those".</p>
 */
export type InviteStateValue = InviteState | (string & {});

/** What an invite is an invite *to*, beyond the guild itself. */
export enum InviteTargetType {
    None = 'None',
    VoiceChannel = 'VoiceChannel',
}

export interface InviteDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    type: InviteType;
    state: InviteStateValue;
    guildId: string;
    guild?: GuildDto;
    code: string;
    expiresAt?: string;
    maxUses?: number | null;
    useCount: number;
    /** The channel a joiner lands on. Advisory unless {@link targetType} gives it meaning. */
    channelId?: string | null;
    /** A user id, not a profile - hydrate it through the profile cache. Null on older invites. */
    inviterId?: string | null;
    /** The membership ends when the member goes offline, unless they are given a role. */
    temporary?: boolean;
    targetType?: InviteTargetType;
    targetUserId?: string | null;
    revokedAt?: string | null;
    /**
     * Present only when the guild has a welcome screen and it's enabled. A non-member
     * can't read the welcome-screen endpoint, so this is the only way to show it before
     * joining.
     */
    welcomeScreen?: WelcomeScreen | null;
}

/** Terminal because somebody took it away. */
export function isInviteRevoked(invite: Pick<InviteDto, 'state'> | null | undefined): boolean {
    return invite?.state === InviteState.Revoked;
}

/** Terminal because it ran out. Distinct from revoked, and rendered differently. */
export function isInviteExpired(invite: Pick<InviteDto, 'state'> | null | undefined): boolean {
    return invite?.state === InviteState.Expired;
}

/**
 * Whether the link is still worth handing to somebody.
 *
 * <p>An unrecognised state counts as usable. A value this build has never heard of is a state the
 * server invented after it shipped, and refusing to copy or join on it would break a link that
 * works; the server refuses the redeem itself if it should not happen.</p>
 */
export function isInviteUsable(invite: Pick<InviteDto, 'state'> | null | undefined): boolean {
    return !!invite && !isInviteRevoked(invite) && !isInviteExpired(invite);
}

/**
 * What the server answered when an invite was redeemed.
 *
 * <p>`202` used to carry no body at all, so every field here is additive and a client that ignores
 * the whole object behaves exactly as it did before.</p>
 */
export interface RedeemInviteResultDto {
    guildId: string;
    channelId?: string | null;
    targetType?: InviteTargetType;
    targetUserId?: string | null;
    /**
     * Connect to `channelId` as voice after joining.
     *
     * <p><b>Read this, never `targetType`.</b> It is false when the target channel has been deleted
     * or stopped being a voice channel since the link was minted - the join still succeeds, only the
     * landing is dropped, and deriving the answer from `targetType` means trying to connect to a
     * room that is not there.</p>
     */
    joinVoice?: boolean;
    /** The rules gate is still pending for this member. */
    onboardingRequired?: boolean;
    /** The membership ends when they go offline, unless they are given a role. Worth saying out loud. */
    temporaryMembership?: boolean;
}
