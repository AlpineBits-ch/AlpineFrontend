import {describe, expect, it} from 'vitest';
import {toContextEvent} from './messaging-websocket.service';

/**
 * Contract §E8: `conversation.MlsCommit` is now emitted for channel contexts too, where it
 * previously went to nobody. The kind of context has to come from which id the payload carries -
 * a client that assumed conversation membership would fetch commits from the wrong route and
 * quietly never catch up on any channel.
 */
describe('toContextEvent', () => {
    it('reads a conversation commit as a conversation', () => {
        const event = toContextEvent({
            contextId: 'conv-1', conversationId: 'conv-1', channelId: null, generation: 2,
        });
        expect(event).toEqual({contextId: 'conv-1', isChannel: false, generation: 2});
    });

    it('reads a channel commit as a channel', () => {
        // The case that previously reached nobody at all.
        const event = toContextEvent({
            contextId: 'chan-1', conversationId: null, channelId: 'chan-1', generation: 3,
        });
        expect(event).toEqual({contextId: 'chan-1', isChannel: true, generation: 3});
    });

    it('prefers the explicit contextId over the id that names the kind', () => {
        // A thread carries its own context id while still being a channel.
        const event = toContextEvent({
            contextId: 'thread-9', conversationId: null, channelId: 'chan-1', generation: 1,
        });
        expect(event.contextId).toBe('thread-9');
        expect(event.isChannel).toBe(true);
    });

    it('falls back to whichever id is present when contextId is absent', () => {
        expect(toContextEvent({conversationId: 'conv-2', generation: 1}).contextId).toBe('conv-2');
        expect(toContextEvent({channelId: 'chan-2', generation: 1}).contextId).toBe('chan-2');
    });

    it('yields an empty context rather than undefined when the payload names nothing', () => {
        // Downstream treats an empty context as "no group here", which is a no-op catch-up. An
        // undefined would be used as a URL segment.
        expect(toContextEvent({generation: 1}).contextId).toBe('');
    });
});
