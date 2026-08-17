import {describe, expect, it} from 'vitest';
import {buildMessageRows, isGroupedWithPrevious} from './message-utils';
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
        const current = makeMessage({
            id: 'm2',
            authorId: 'author-b',
            createdAt: new Date('2026-07-28T10:00:05.000Z'),
        });
        expect(isGroupedWithPrevious(current, previous)).toBe(false);
    });

    it('returns false when the current message is a reply', () => {
        const previous = makeMessage({id: 'm1'});
        const current = makeMessage({
            id: 'm2',
            createdAt: new Date('2026-07-28T10:00:05.000Z'),
            inReplyTo: 'm0',
        });
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

describe('buildMessageRows', () => {
    const now = new Date(2026, 2, 14, 10, 0, 0);

    it('separates the first row of the loaded window', () => {
        const rows = buildMessageRows([makeMessage({id: 'm1', createdAt: new Date(2026, 2, 14, 9, 0)})], now);
        expect(rows[0].daySeparator?.relation).toBe('today');
    });

    it('separates only where the local day changes', () => {
        const rows = buildMessageRows(
            [
                makeMessage({id: 'm1', createdAt: new Date(2026, 2, 13, 9, 0)}),
                makeMessage({id: 'm2', createdAt: new Date(2026, 2, 13, 23, 59)}),
                makeMessage({id: 'm3', createdAt: new Date(2026, 2, 14, 0, 1)}),
            ],
            now,
        );
        expect(rows.map(r => r.daySeparator !== null)).toEqual([true, false, true]);
        expect(rows.map(r => r.daySeparator?.relation ?? 'none')).toEqual(['yesterday', 'none', 'today']);
    });

    it('breaks grouping across a separator', () => {
        // Same author a second apart, but on either side of midnight.
        const rows = buildMessageRows(
            [
                makeMessage({id: 'm1', createdAt: new Date(2026, 2, 13, 23, 59, 59)}),
                makeMessage({id: 'm2', createdAt: new Date(2026, 2, 14, 0, 0, 0)}),
            ],
            now,
        );
        expect(rows[1].daySeparator).not.toBe(null);
        expect(rows[1].isGrouped).toBe(false);
    });

    it('keeps grouping within a day', () => {
        const rows = buildMessageRows(
            [
                makeMessage({id: 'm1', createdAt: new Date(2026, 2, 14, 9, 0, 0)}),
                makeMessage({id: 'm2', createdAt: new Date(2026, 2, 14, 9, 0, 5)}),
            ],
            now,
        );
        expect(rows[1].daySeparator).toBe(null);
        expect(rows[1].isGrouped).toBe(true);
    });

    it('names an older day null so the view formats its date', () => {
        const rows = buildMessageRows([makeMessage({id: 'm1', createdAt: new Date(2026, 1, 2, 9, 0)})], now);
        expect(rows[0].daySeparator?.relation).toBe(null);
        expect(rows[0].daySeparator?.date.getFullYear()).toBe(2026);
    });

    it('heads no day for an unparseable timestamp, and still starts a fresh day after it', () => {
        const rows = buildMessageRows(
            [
                makeMessage({id: 'm1', createdAt: new Date(2026, 2, 14, 9, 0)}),
                makeMessage({id: 'm2', createdAt: 'nonsense' as unknown as Date}),
                makeMessage({id: 'm3', createdAt: new Date(2026, 2, 14, 9, 0, 5)}),
            ],
            now,
        );
        expect(rows[1].daySeparator).toBe(null);
        expect(rows[1].isGrouped).toBe(false);
        expect(rows[2].daySeparator?.relation).toBe('today');
    });

    it('returns an empty list for no messages', () => {
        expect(buildMessageRows([], now)).toEqual([]);
    });
});
