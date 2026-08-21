import {describe, expect, it} from 'vitest';
import {
    GuildMessageCreatedPayload,
    mapGuildEphemeralMessagePayload,
    mapGuildMessageCreatedPayload,
    mapGuildMessageUpdatedPayload,
    normalizeWireContent,
} from '../dtos/response/guild-message-events.dto';
import {toChannelJoinRequestEvent} from '../dtos/response/guild-channel-events.dto';
import {MessageType} from '../enums/message-type.enum';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {fromBase64} from '../helpers/base64.helper';

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

    // A dice roll never comes back over HTTP, so this socket is the only delivery even for the
    // person who rolled it. Dropping these renders every roll under the account, not the character.
    it('carries the persona overrides a message was spoken under', () => {
        const result = mapGuildMessageCreatedPayload({
            ...BASE_PAYLOAD,
            type: 'DiceRoll',
            personaId: 'pers_1',
            authorDisplayName: 'Mayor Cogsgrove',
            authorAvatarUrl: 'https://cdn.test.example/mayor.png',
        });

        expect(result.personaId).toBe('pers_1');
        expect(result.authorDisplayName).toBe('Mayor Cogsgrove');
        expect(result.authorAvatarUrl).toBe('https://cdn.test.example/mayor.png');
    });

    it('leaves the persona overrides empty on a message nobody spoke in character', () => {
        const result = mapGuildMessageCreatedPayload(BASE_PAYLOAD);

        expect(result.personaId ?? null).toBeNull();
        expect(result.authorDisplayName ?? null).toBeNull();
        expect(result.authorAvatarUrl ?? null).toBeNull();
    });
});

/**
 * The body is a `byte[]` server-side, and which of its two JSON forms arrives depends on the host's
 * serializer. Everything downstream base64-decodes unconditionally, so the wrong one reaching the
 * store renders as `[104,101,...]` under the author's name.
 */
describe('normalizeWireContent', () => {
    it('passes a base64 string through untouched', () => {
        expect(normalizeWireContent('aGVsbG8=')).toBe('aGVsbG8=');
    });

    it('base64-encodes a raw byte array so readers decode the same text', () => {
        // "hello"
        const encoded = normalizeWireContent([104, 101, 108, 108, 111]);
        expect(fromBase64(encoded)).toBe('hello');
    });

    it('survives a body long enough to overflow a spread argument list', () => {
        const bytes = new Array(200_000).fill(97);
        expect(fromBase64(normalizeWireContent(bytes))).toHaveLength(200_000);
    });

    it('treats a missing body as empty rather than throwing', () => {
        expect(normalizeWireContent(undefined)).toBe('');
        expect(normalizeWireContent(null)).toBe('');
    });
});

describe('mapGuildMessageUpdatedPayload', () => {
    it('produces a channel-shaped MessageUpdatedEvent', () => {
        const result = mapGuildMessageUpdatedPayload({
            messageId: 'mesg_1',
            channelId: 'chan_1',
            authorId: 'user_1',
            content: 'aGVsbG8=',
        });

        expect(result.channelId).toBe('chan_1');
        // Never carried on a channel edit: `applyRemoteUpdate` picks the decrypt route from the
        // stored message, and a conversation id invented here would send it down the wrong one.
        expect(result.conversationId).toBeUndefined();
        expect(result.content).toBe('aGVsbG8=');
    });

    it('normalizes a byte-array body, so an edit is not rendered as a list of numbers', () => {
        const result = mapGuildMessageUpdatedPayload({
            messageId: 'mesg_1',
            channelId: 'chan_1',
            authorId: 'user_1',
            content: [104, 105],
        });

        expect(fromBase64(result.content)).toBe('hi');
    });
});

describe('mapGuildEphemeralMessagePayload', () => {
    const BASE = {
        id: 'mesg_eph',
        guildId: 'guil_1',
        channelId: 'chan_1',
        content: 'Only you can see this',
        authorId: 'bot_1',
        createdAt: '2026-08-03T10:00:00Z',
    };

    it('base64-encodes the body, which arrives as plain text unlike every other message event', () => {
        const result = mapGuildEphemeralMessagePayload(BASE);
        expect(fromBase64(result.content)).toBe('Only you can see this');
    });

    it('encodes a body that is itself valid base64, rather than letting the reader decode it twice', () => {
        // "test" decodes as base64 to two junk bytes, so passing it through unencoded is not a
        // no-op - it is the exact case where a tolerant decoder produces mojibake instead of text.
        const result = mapGuildEphemeralMessagePayload({...BASE, content: 'test'});
        expect(fromBase64(result.content)).toBe('test');
    });

    it('marks it ephemeral so nothing offers to edit or delete a message with no stored row', () => {
        expect(mapGuildEphemeralMessagePayload(BASE).isEphemeral).toBe(true);
    });

    it('serializes embeds into embedsJson, and leaves it unset when there are none', () => {
        const withEmbeds = mapGuildEphemeralMessagePayload({
            ...BASE,
            embeds: [{title: 'Result', fields: [{name: 'n', value: 'v', inline: false}]}],
        });
        expect(JSON.parse(withEmbeds.embedsJson!)[0].title).toBe('Result');
        expect(mapGuildEphemeralMessagePayload(BASE).embedsJson).toBeUndefined();
    });
});

/**
 * The channel twin of `conversation.MlsJoinRequest`, whose published payload is three ids. The one
 * field that is a policy decision has to fail closed even though this event never carries it.
 */
describe('toChannelJoinRequestEvent', () => {
    const BASE = {channelId: 'chan_1', guildId: 'guil_1', requesterUserId: 'user_2'};

    it('requires manual approval when the payload says nothing about it', () => {
        expect(toChannelJoinRequestEvent(BASE).requiresManualApproval).toBe(true);
    });

    it('requires manual approval when the field is explicitly true', () => {
        expect(
            toChannelJoinRequestEvent({...BASE, requiresManualApproval: true}).requiresManualApproval,
        ).toBe(true);
    });

    it('only skips manual approval when a server explicitly says so', () => {
        expect(
            toChannelJoinRequestEvent({...BASE, requiresManualApproval: false}).requiresManualApproval,
        ).toBe(false);
    });

    it('marks the context as a channel, so the review surface reads the channel route', () => {
        const event = toChannelJoinRequestEvent(BASE);
        expect(event.isChannel).toBe(true);
        expect(event.contextId).toBe('chan_1');
    });

    it('leaves the fields the push does not carry empty rather than fabricating them', () => {
        const event = toChannelJoinRequestEvent(BASE);
        expect(event.requestId).toBe('');
        expect(event.requesterDeviceId).toBe('');
        // Empty, never a placeholder string: this is the value a human compares out of band, and
        // anything printable here could be mistaken for a fingerprint that matched.
        expect(event.signatureKeyFingerprint).toBe('');
        expect(event.requesterDeviceName).toBeNull();
    });

    it('believes a server that starts sending the fuller conversation-shaped payload', () => {
        const event = toChannelJoinRequestEvent({
            ...BASE,
            requestId: 'mljr-1',
            requesterDeviceId: 'device-theirs',
            requesterDeviceName: 'Bob laptop',
            signatureKeyFingerprint: '517F4-D75A0',
            generation: 3,
        });

        expect(event.requestId).toBe('mljr-1');
        expect(event.signatureKeyFingerprint).toBe('517F4-D75A0');
        expect(event.generation).toBe(3);
        expect(event.requesterDeviceName).toBe('Bob laptop');
    });
});
