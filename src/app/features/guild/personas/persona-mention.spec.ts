import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {identityFromHint} from './persona-identity';
import {isPersonaId, personaMentionIds, personaMentionPattern, personaMentionToken} from './persona-mention';

describe('the persona mention token', () => {
    it('is an id, never a name', () => {
        expect(personaMentionToken('pers_cogsgrove')).toBe('<@pers_cogsgrove>');
    });

    it('finds every character named in a body, once each', () => {
        const body = 'Cogsgrove looks at <@pers_wren>, then at <@pers_wren> again, then <@pers_thorne>.';
        expect(personaMentionIds(body)).toEqual(['pers_wren', 'pers_thorne']);
    });

    it('ignores anything that is not a character id', () => {
        expect(personaMentionIds('<@user_123> <@1234> @wren <@pers>')).toEqual([]);
    });

    it('accepts only ids with the character prefix', () => {
        expect(isPersonaId('pers_wren')).toBe(true);
        expect(isPersonaId('user_wren')).toBe(false);
        expect(isPersonaId('')).toBe(false);
    });

    it('captures the id and nothing around it, so a body cannot smuggle markup through', () => {
        const match = personaMentionPattern().exec('a <@pers_wren> b');
        expect(match?.[0]).toBe('<@pers_wren>');
        expect(match?.[1]).toBe('pers_wren');
    });
});

describe('identityFromHint', () => {
    it('carries the character, and has nowhere to put an account', () => {
        const identity = identityFromHint('pers_wren', {name: 'Wren Adaire', color: '#6ba368'});
        expect(identity).toEqual({
            personaId: 'pers_wren',
            name: 'Wren Adaire',
            avatarUrl: null,
            tag: null,
            color: '#6ba368',
            pronouns: null,
            initial: 'W',
            isRetired: false,
        });
    });

    it('is null without a name, so a half-filled hint cannot render as a blank chip', () => {
        expect(identityFromHint('pers_wren', {color: '#6ba368'})).toBeNull();
        expect(identityFromHint('pers_wren', null)).toBeNull();
    });

    it('drops a colour that is not a hex value', () => {
        expect(identityFromHint('pers_wren', {name: 'Wren', color: 'red'})?.color).toBeNull();
    });
});

/**
 * Mentioning a character notifies its player and must never tell anyone else who that is. The two
 * assertions below guard the two ways that could be undone: routing the chip at an account, or
 * hanging the owner off it as a title.
 */
describe('the mention chip reveals no account', () => {
    const template = readFileSync(
        join(__dirname, '../../messaging/components/conversation/message/message.component.html'),
        'utf8',
    );

    const branch = (() => {
        const start = template.indexOf("seg.type === 'persona'");
        expect(start, 'the persona mention branch has moved').toBeGreaterThan(-1);
        const end = template.indexOf('@else if', start);
        return template.slice(start, end === -1 ? template.length : end);
    })();

    it('opens the character page rather than a profile', () => {
        expect(branch).toContain('openMentionedCharacter');
        expect(branch).not.toContain('profilePopout');
        expect(branch).not.toContain('authorId');
    });

    it('hangs nothing on hover that a name could be read out of', () => {
        expect(branch).not.toContain('title');
        expect(branch).not.toContain('getProfile');
        expect(branch).not.toContain('PLAYED_BY');
    });
});
