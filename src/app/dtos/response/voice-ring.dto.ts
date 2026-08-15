/**
 * The ephemeral "come and join me in here" invitation.
 *
 * <p><b>It is not a call.</b> There is no media session and no roster slot behind a ring - it holds
 * nothing to tear down, which is why a device that answers late is simply dismissed rather than
 * taken over. It is also not the persistent invite link with a voice target: that is a credential
 * anybody can paste anywhere, this is a message to one named member that expires in 60 seconds
 * whether or not anyone looks at it.</p>
 */
export interface VoiceRingDto {
    ringId: string;
    guildId: string;
    channelId: string;
    /** Null on the response to your own send - you know the channel. Filled in everywhere else. */
    channelName: string | null;
    inviterId: string;
    targetUserId: string;
    status: VoiceRingStatusValue;
    reason: VoiceRingReasonValue | null;
    createdAt: string;
    expiresAt: string;
    /**
     * <b>Count down from this, not from `expiresAt`.</b> A machine whose clock is a few minutes out
     * is ordinary rather than exotic, and trusting the absolute instant there draws an invitation
     * that is already dead or one that never lapses.
     */
    expiresInSeconds: number;
    resolvedByDeviceId: string | null;
}

/**
 * How hard to knock, sent as `delivery` on the ring request.
 *
 * <p>The server defaults to {@link Both} for the sake of clients that predate the field. This client
 * always says which it wants.</p>
 */
export enum VoiceRingDelivery {
    /** The invitation goes in the DM and nowhere else. Nothing rings, nothing expires. */
    Message = 'Message',
    /** The ephemeral ring alone, leaving no record once it lapses. */
    Ring = 'Ring',
    /** The ring now, and the card that outlives it. */
    Both = 'Both',
}

/**
 * The answer to a {@link VoiceRingDelivery.Message} invitation.
 *
 * <p>Deliberately not a {@link VoiceRingDto}: there is no ring, so there is no id to accept and no
 * instant to count down to. What comes back is where the card landed, which may be a conversation
 * that did not exist a moment ago.</p>
 */
export interface VoiceInviteSentDto {
    conversationId: string;
}

export enum VoiceRingStatus {
    Pending = 'Pending',
    Accepted = 'Accepted',
    Declined = 'Declined',
    Cancelled = 'Cancelled',
    Expired = 'Expired',
}

/**
 * Widened past the enum for the same reason invite `state` is: one event covers every way a ring
 * ends, so a value this build has not heard of must fall back on the ones it has rather than throw.
 */
export type VoiceRingStatusValue = VoiceRingStatus | (string & {});

/** Why a ring ended, when a button press does not explain it. Null for a plain accept or decline. */
export enum VoiceRingReason {
    InviterCancelled = 'InviterCancelled',
    /** The inviter left the voice channel, so the invitation is no longer true. */
    InviterLeft = 'InviterLeft',
    /** The same inviter rang the same person into a different channel. */
    Superseded = 'Superseded',
    /** They joined that channel by ordinary means. Not an accept - they may never have seen it. */
    TargetJoined = 'TargetJoined',
    /** Deleted, no longer a voice channel, or access lost. */
    ChannelGone = 'ChannelGone',
    /** Nobody answered inside the 60 seconds. */
    TimedOut = 'TimedOut',
}

export type VoiceRingReasonValue = VoiceRingReason | (string & {});

/** Why a ring was refused. `retryAfterSeconds` is zero for anything waiting will not fix. */
export interface VoiceRingRefusalDto {
    reason: VoiceRingRefusalReasonValue;
    retryAfterSeconds: number;
}

export enum VoiceRingRefusalReason {
    /** They cannot see or cannot connect to that channel. */
    TargetCannotJoinChannel = 'TargetCannotJoinChannel',
    /**
     * A block exists, in one direction or the other.
     *
     * <p><b>Never render this as "you are blocked."</b> The server deliberately does not say which
     * direction it runs in, and spelling it out would turn a refusal into a disclosure about
     * somebody else's block list.</p>
     */
    Unavailable = 'Unavailable',
    /** They walked into the channel while the button was being pressed. Not an error. */
    TargetAlreadyInChannel = 'TargetAlreadyInChannel',
    /** They turned this inviter down recently. Escalates: 15 minutes, then 2 hours, then 24. */
    RecentlyDeclined = 'RecentlyDeclined',
    /** This account has sent too many rings - 6 in 5 minutes, to anybody. */
    InviterFlooding = 'InviterFlooding',
    /** They have been rung too often by too many people. Not this inviter's fault. */
    TargetSaturated = 'TargetSaturated',
}

export type VoiceRingRefusalReasonValue = VoiceRingRefusalReason | (string & {});

/** `guild.VoiceRingIncoming` (to the target) and `guild.VoiceRingSent` (to the inviter). */
export interface WsVoiceRing {
    ringId: string;
    guildId: string;
    channelId: string;
    channelName: string | null;
    inviterId: string;
    /** A frozen copy that can be null if the profile lookup failed. Resolve `inviterId` instead. */
    inviterName: string | null;
    inviterAvatarUrl: string | null;
    targetUserId: string;
    createdAt: string;
    expiresAt: string;
    expiresInSeconds: number;
    /** Who is already in the channel, so the card can show faces. Safe to render. */
    participantUserIds: string[];
}

/** `guild.VoiceRingResolved` - one event for every way a ring ends. */
export interface WsVoiceRingResolved {
    ringId: string;
    guildId: string;
    channelId: string;
    inviterId: string;
    targetUserId: string;
    status: VoiceRingStatusValue;
    reason: VoiceRingReasonValue | null;
    resolvedAt: string;
    /** The device that answered, or null for a resolution nobody pressed a button for. */
    resolvedByDeviceId: string | null;
}

/**
 * `guild.VoiceRingDismissed` - addressed to exactly one device of the target.
 *
 * <p>Sent when a device answers a ring that was already resolved, typically a laptop a second after
 * a phone. Take the card down there; the ring itself is untouched.</p>
 */
export interface WsVoiceRingDismissed {
    ringId: string;
    deviceId: string;
    status: VoiceRingStatusValue;
    reason: VoiceRingReasonValue | null;
}
