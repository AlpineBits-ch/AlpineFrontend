import {describe, expect, it} from 'vitest';
import {MessageType} from './message-type.enum';

describe('MessageType', () => {
    it('defines the backend-provided system message types', () => {
        expect(MessageType.Message).toBe('Message');
        expect(MessageType.Invite).toBe('Invite');
        expect(MessageType.GuildMemberJoin).toBe('GuildMemberJoin');
        expect(MessageType.GuildMemberLeave).toBe('GuildMemberLeave');
    });
});
