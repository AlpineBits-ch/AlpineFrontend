import {describe, expect, it} from 'vitest';
import {
    canSpeakAs,
    matchesPersonaQuery,
    messageAuthorIdentity,
    personaIdentity,
    sameSpeaker,
    sortPersonas,
} from './persona-identity';
import {
    GuildPersonaDto,
    PersonaApprovalState,
    PersonaDto,
    PersonaScope,
} from '../../../dtos/response/persona.dto';
import {MessageDto} from '../../../dtos/response/message.dto';
import {MessageType} from '../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../enums/message-encryption-state.enum';

function persona(over: Partial<PersonaDto> = {}): PersonaDto {
    return {
        id: 'p1',
        scope: PersonaScope.User,
        ownerUserId: 'u1',
        name: 'Mayor Cogsgrove',
        avatarUrl: 'https://cdn/global.png',
        pronouns: 'he/him',
        color: '#b08968',
        shortBio: null,
        isRetired: false,
        createdAt: '2026-01-01T00:00:00Z',
        ...over,
    };
}

/** Shaped like the wire: the profile's own fields at the top level, the character nested. */
function entry(
    personaOver: Partial<PersonaDto> = {},
    profileOver: Partial<GuildPersonaDto> = {},
): GuildPersonaDto {
    return {
        personaId: personaOver.id ?? 'p1',
        guildId: 'g1',
        approvalState: PersonaApprovalState.Approved,
        canSpeak: true,
        persona: persona(personaOver),
        ...profileOver,
    };
}

function message(over: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'm1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content: '',
        channelId: 'c1',
        conversationId: undefined,
        authorId: 'u1',
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
        ...over,
    };
}

describe('personaIdentity', () => {
    it('falls back to the global row when nothing is overridden', () => {
        expect(personaIdentity(entry())).toMatchObject({
            name: 'Mayor Cogsgrove',
            avatarUrl: 'https://cdn/global.png',
            tag: null,
            color: '#b08968',
        });
    });

    it('lets the guild override the name and avatar', () => {
        const identity = personaIdentity(
            entry({}, {displayName: 'The Mayor', avatarUrl: 'https://cdn/here.png', tag: 'Ashfen'}),
        );
        expect(identity).toMatchObject({
            name: 'The Mayor',
            avatarUrl: 'https://cdn/here.png',
            tag: 'Ashfen',
        });
    });

    it('takes the initial from the overridden name, not the global one', () => {
        expect(personaIdentity(entry({}, {displayName: 'Wren'})).initial).toBe('W');
    });

    it('drops a colour that is not a plain six-digit hex', () => {
        expect(personaIdentity(entry({color: 'rebeccapurple'})).color).toBeNull();
    });
});

describe('canSpeakAs', () => {
    it('refuses a retired character even where the server still says it may speak', () => {
        expect(canSpeakAs(entry({isRetired: true}, {canSpeak: true}))).toBe(false);
    });

    it('refuses one the server has gated', () => {
        expect(canSpeakAs(entry({}, {canSpeak: false}))).toBe(false);
    });

    it('allows an approved, live character', () => {
        expect(canSpeakAs(entry())).toBe(true);
    });
});

describe('sortPersonas', () => {
    it('puts retired characters last, and sorts the rest by the name shown here', () => {
        const rows = [
            entry({id: 'c', name: 'Zed'}),
            entry({id: 'a', name: 'Old One', isRetired: true}),
            entry({id: 'b', name: 'Zed the Elder'}, {displayName: 'Ana'}),
        ];
        expect(sortPersonas(rows).map(r => r.persona.id)).toEqual(['b', 'c', 'a']);
    });
});

describe('matchesPersonaQuery', () => {
    const row = entry({}, {tag: 'Ashfen', proxyPrefix: 'c:'});

    it('matches the guild name', () => {
        expect(matchesPersonaQuery(row, 'cogs')).toBe(true);
    });

    it('matches the tag and the proxy prefix', () => {
        expect(matchesPersonaQuery(row, 'ashfen')).toBe(true);
        expect(matchesPersonaQuery(row, 'c:')).toBe(true);
    });

    it('matches everything on an empty query', () => {
        expect(matchesPersonaQuery(row, '   ')).toBe(true);
    });

    it('does not match an unrelated word', () => {
        expect(matchesPersonaQuery(row, 'harbour')).toBe(false);
    });
});

describe('messageAuthorIdentity', () => {
    it('reads the overrides denormalised on the message', () => {
        const identity = messageAuthorIdentity(
            message({authorDisplayName: 'Wren', authorAvatarUrl: 'x', personaId: 'p2'}),
        );
        expect(identity).toEqual({
            name: 'Wren',
            avatarUrl: 'x',
            personaId: 'p2',
            inCharacter: true,
        });
    });

    it('is not in character for a webhook, which has overrides but no persona', () => {
        const identity = messageAuthorIdentity(message({authorDisplayName: 'Deploy bot'}));
        expect(identity.inCharacter).toBe(false);
        expect(identity.personaId).toBeNull();
    });
});

describe('sameSpeaker', () => {
    it('is false when one account speaks as two characters', () => {
        expect(sameSpeaker(message({personaId: 'p1'}), message({personaId: 'p2'}))).toBe(false);
    });

    it('is false between a character and the account behind it', () => {
        expect(sameSpeaker(message({personaId: 'p1'}), message())).toBe(false);
    });

    it('is true for the same character twice', () => {
        expect(sameSpeaker(message({personaId: 'p1'}), message({personaId: 'p1'}))).toBe(true);
    });
});
