import {ConversationEncryption} from '../../enums/conversation-encryption.enum';

export interface ConversationMemberDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    cachedUserName: string;
    lastReadMessageId: string | undefined;
    mentionCount: number;
}

export interface ConversationDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string | undefined;
    members: ConversationMemberDto[];
    encryptionState: ConversationEncryption;
    /**
     * Present on the **creation response only**: member devices that were not added to the MLS
     * group and can never read this conversation.
     *
     * The server is permissive during the rollout, so it reports rather than refusing. This client
     * checks reachability before it builds the group, but a device that registered between that
     * check and this response would show up only here - so both are read.
     */
    unreachableDevices?: {userId: string; deviceId: string; deviceName: string}[];
}
