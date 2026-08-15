import {InviteTargetType, InviteType} from "../response/invite.dto";


export interface CreateInviteDto {
    type: InviteType;
    expiresAt?: string;
    /**
     * How many times the link may be redeemed. Omit for unlimited.
     *
     * <p><b>`0` is refused with a `400`.</b> An invite that is exhausted the moment it exists is a
     * link somebody is about to share, so the server stopped accepting it rather than minting one.</p>
     */
    maxUses?: number;
    /** The channel a joiner lands on. Required when {@link targetType} is `VoiceChannel`. */
    channelId?: string;
    /** Grant a membership that ends when the member goes offline, unless they get a role. */
    temporary?: boolean;
    targetType?: InviteTargetType;
    /** Advisory: who the invite was meant for. Not enforced at redemption. */
    targetUserId?: string;
}
