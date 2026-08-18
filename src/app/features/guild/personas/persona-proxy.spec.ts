import {describe, expect, it} from 'vitest';
import {findTagCollision, formatProxyTags, matchProxyTags, ProxyTags, resolveProxy} from './persona-proxy';
import {AutoproxyMode, ChannelAutoproxyDto} from '../../../dtos/response/persona.dto';

const cogsgrove: ProxyTags = {personaId: 'p1', prefix: 'c:', suffix: null};
const wren: ProxyTags = {personaId: 'p2', prefix: 'w:', suffix: null};
const thorne: ProxyTags = {personaId: 'p3', prefix: '[[', suffix: ']]'};
const untagged: ProxyTags = {personaId: 'p4', prefix: null, suffix: null};

const candidates = [cogsgrove, wren, thorne, untagged];

function autoproxy(mode: AutoproxyMode, personaId: string | null): ChannelAutoproxyDto {
    return {channelId: 'chan', mode, personaId};
}

describe('matchProxyTags', () => {
    it('matches a prefix', () => {
        expect(matchProxyTags('c: good evening', candidates)).toBe(cogsgrove);
    });

    it('requires both halves of a prefix/suffix pair', () => {
        expect(matchProxyTags('[[ he draws ]]', candidates)).toBe(thorne);
        expect(matchProxyTags('[[ he draws', candidates)).toBeNull();
    });

    it('ignores a persona with no tags at all', () => {
        expect(matchProxyTags('anything', candidates)).toBeNull();
    });

    it('takes the longer tag when one is a prefix of another', () => {
        const short: ProxyTags = {personaId: 'a', prefix: 'A', suffix: null};
        const long: ProxyTags = {personaId: 'b', prefix: 'AB', suffix: null};
        expect(matchProxyTags('AB hello', [short, long])).toBe(long);
    });

    it('will not match a body shorter than the tags it would strip', () => {
        expect(matchProxyTags('[[', candidates)).toBeNull();
    });
});

describe('resolveProxy', () => {
    it('speaks as nobody when nothing applies', () => {
        const result = resolveProxy('hello', {candidates});
        expect(result).toMatchObject({personaId: null, content: 'hello', source: 'none'});
    });

    it('lets an explicit pick win over a tag', () => {
        const result = resolveProxy('c: hello', {explicitPersonaId: 'p2', candidates});
        expect(result.personaId).toBe('p2');
        expect(result.source).toBe('explicit');
        // The server strips it, so the content must go out untouched.
        expect(result.content).toBe('c: hello');
    });

    it('strips a matched prefix', () => {
        const result = resolveProxy('c: good evening', {candidates});
        expect(result).toMatchObject({personaId: 'p1', content: 'good evening', source: 'tag'});
        expect(result.matched).toEqual({prefix: 'c:', suffix: ''});
    });

    it('strips both halves of a wrapping pair', () => {
        const result = resolveProxy('[[she draws]]', {candidates});
        expect(result).toMatchObject({personaId: 'p3', content: 'she draws', source: 'tag'});
    });

    it('falls back to autoproxy', () => {
        const result = resolveProxy('hello', {
            candidates,
            autoproxy: autoproxy(AutoproxyMode.Pinned, 'p1'),
        });
        expect(result).toMatchObject({personaId: 'p1', content: 'hello', source: 'autoproxy'});
    });

    it('treats Sticky the same, since both modes hold the character in one field', () => {
        const result = resolveProxy('hello', {
            candidates,
            autoproxy: autoproxy(AutoproxyMode.Sticky, 'p2'),
        });
        expect(result.personaId).toBe('p2');
    });

    it('ignores autoproxy that is off', () => {
        const result = resolveProxy('hello', {
            candidates,
            autoproxy: autoproxy(AutoproxyMode.Off, 'p1'),
        });
        expect(result.personaId).toBeNull();
    });

    it('ignores an autoproxy mode with no character behind it', () => {
        const result = resolveProxy('hello', {
            candidates,
            autoproxy: autoproxy(AutoproxyMode.Sticky, null),
        });
        expect(result.personaId).toBeNull();
    });

    it('lets a leading backslash beat a tag, autoproxy and an explicit pick', () => {
        const result = resolveProxy('\\c: out of character', {
            explicitPersonaId: 'p2',
            candidates,
            autoproxy: autoproxy(AutoproxyMode.Pinned, 'p1'),
        });
        expect(result).toMatchObject({
            personaId: null,
            content: 'c: out of character',
            source: 'escaped',
        });
    });

    it('only honours a backslash at the very start', () => {
        const result = resolveProxy('she wrote \\ on the wall', {candidates});
        expect(result.source).toBe('none');
        expect(result.content).toBe('she wrote \\ on the wall');
    });
});

describe('formatProxyTags', () => {
    it('shows both halves around the word', () => {
        expect(formatProxyTags({prefix: '[[', suffix: ']]'})).toBe('[[text]]');
    });

    it('is empty when there is nothing to show', () => {
        expect(formatProxyTags({prefix: null, suffix: null})).toBe('');
    });
});

describe('findTagCollision', () => {
    it('names the persona already using the pair', () => {
        expect(findTagCollision({prefix: 'c:', suffix: null}, 'p9', candidates)).toBe(cogsgrove);
    });

    it('does not collide with the persona being edited', () => {
        expect(findTagCollision({prefix: 'c:', suffix: null}, 'p1', candidates)).toBeNull();
    });

    it('treats an empty pair as no tag rather than a collision with every other empty one', () => {
        expect(findTagCollision({prefix: '', suffix: ''}, 'p9', candidates)).toBeNull();
    });
});
