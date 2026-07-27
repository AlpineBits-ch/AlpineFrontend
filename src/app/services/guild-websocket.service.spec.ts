import {describe, expect, it} from 'vitest';
import {GuildMessageCreatedPayload, mapGuildMessageCreatedPayload} from './guild-websocket.service';
import {MessageType} from '../enums/message-type.enum';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';

const BASE_PAYLOAD: GuildMessageCreatedPayload = {
    messageId: 'mesg_1',
    content: 'aGVsbG8=',
    authorId: 'user_1',
    conversationId: undefined,
    channelId: 'chan_1',
    attachments: [],
    inReplyTo: undefined,
    mentions: undefined,
    embedsJson: undefined,
    type: 'Message',
    systemMessageVariant: undefined,
};

describe('mapGuildMessageCreatedPayload', () => {
    it('maps an ordinary chat message with type Message', () => {
        const result = mapGuildMessageCreatedPayload(BASE_PAYLOAD);
        expect(result.type).toBe(MessageType.Message);
        expect(result.systemMessageVariant).toBeUndefined();
        expect(result.id).toBe('mesg_1');
        expect(result.encryptionState).toBe(MessageEncryptionState.Plain);
    });

    it('preserves type and systemMessageVariant for a GuildMemberJoin system message', () => {
        const payload: GuildMessageCreatedPayload = {
            ...BASE_PAYLOAD,
            type: 'GuildMemberJoin',
            systemMessageVariant: 4,
            authorId: 'user_2',
        };
        const result = mapGuildMessageCreatedPayload(payload);
        expect(result.type).toBe(MessageType.GuildMemberJoin);
        expect(result.systemMessageVariant).toBe(4);
        expect(result.authorId).toBe('user_2');
    });

    it('defaults mentions to an empty array when the payload omits them', () => {
        const result = mapGuildMessageCreatedPayload(BASE_PAYLOAD);
        expect(result.mentions).toEqual([]);
    });
});
