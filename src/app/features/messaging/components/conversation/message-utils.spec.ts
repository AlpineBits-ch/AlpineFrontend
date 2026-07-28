import {describe, expect, it} from 'vitest';
import {isGroupedWithPrevious} from './message-utils';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageType} from '../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';

function makeMessage(overrides: Partial<MessageDto>): MessageDto {
    return {
        id: 'm1',
        createdAt: new Date('2026-07-28T10:00:00.000Z'),
        updatedAt: new Date('2026-07-28T10:00:00.000Z'),
        content: '',
        channelId: 'c1',
        conversationId: undefined,
        authorId: 'author-a',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.Message,
        ...overrides,
    };
}

describe('isGroupedWithPrevious', () => {
    it('returns false when there is no previous message', () => {
        const current = makeMessage({id: 'm1'});
        expect(isGroupedWithPrevious(current, undefined)).toBe(false);
    });

    it('returns true for the same author within the 20s window', () => {
        const previous = makeMessage({id: 'm1', createdAt: new Date('2026-07-28T10:00:00.000Z')});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:19.999Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(true);
    });

    it('returns false for the same author past the 20s window', () => {
        const previous = makeMessage({id: 'm1', createdAt: new Date('2026-07-28T10:00:00.000Z')});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:20.001Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false for a different author', () => {
        const previous = makeMessage({id: 'm1', authorId: 'author-a'});
        const current = makeMessage({id: 'm2', authorId: 'author-b', createdAt: new Date('2026-07-28T10:00:05.000Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false when the current message is a reply', () => {
        const previous = makeMessage({id: 'm1'});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:05.000Z'), inReplyTo: 'm0'});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false when the previous message is a system message', () => {
        const previous = makeMessage({id: 'm1', type: MessageType.GuildMemberJoin});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:05.000Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns true at the exact 20s boundary', () => {
        const previous = makeMessage({id: 'm1', createdAt: new Date('2026-07-28T10:00:00.000Z')});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:20.000Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(true);
    });

    it('returns false when the current message is earlier than the previous one (out of order)', () => {
        const previous = makeMessage({id: 'm1', createdAt: new Date('2026-07-28T10:00:10.000Z')});
        const current = makeMessage({id: 'm2', createdAt: new Date('2026-07-28T10:00:05.000Z')});
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });
});
