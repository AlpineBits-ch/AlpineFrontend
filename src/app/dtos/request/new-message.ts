import {CreateMessageDto} from './create-message.dto';

/** A plain text message with nothing attached, mentioned or replied to. */
export function newMessage(conversationId: string, content: string): CreateMessageDto {
    return {
        content,
        conversationId,
        channelId: undefined,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
    };
}
