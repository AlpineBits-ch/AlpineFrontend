import {ConversationEncryption} from '../../enums/conversation-encryption.enum';

export interface CreateConversationMemberDto {
    userId: string;
}

export interface DeviceWelcomeDto {
    deviceId: string;
    /** Base64-encoded MLS Welcome message */
    welcome: string;
    userId: string;
}

export interface CreateConversationDto {
    name: string | undefined;
    members: CreateConversationMemberDto[];
    encryption: ConversationEncryption;
    deviceWelcomes: DeviceWelcomeDto[];
    /** Base64-encoded MLS group ID bytes */
    mlsGroupId?: string;
    mlsEpoch?: number;
    /** Base64-encoded MLS GroupInfo bytes */
    mlsGroupInfo?: string;
    /**
     * Sent only when the caller has been shown the devices that cannot be reached and chose to go
     * ahead anyway. A record that a human decided, not a way to skip the check - those devices will
     * never be able to read a word of the conversation.
     */
    allowPartialDeviceCoverage?: boolean;
}
