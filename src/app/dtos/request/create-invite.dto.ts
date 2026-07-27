import {InviteType} from "../response/invite.dto";


export interface CreateInviteDto {
    type: InviteType;
    expiresAt?: string;
    maxUses?: number;
    channelId?: string;
}