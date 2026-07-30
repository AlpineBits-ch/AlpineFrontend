import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {classifyAutoModError, forumParentOf} from './channel-utils';

function makeError(status: number, error: unknown): HttpErrorResponse {
    return new HttpErrorResponse({status, error});
}

describe('classifyAutoModError', () => {
    it('classifies a structured 403 with reason "rate_limited"', () => {
        const err = makeError(403, {error: 'automod_blocked', reason: 'rate_limited'});
        expect(classifyAutoModError(err)).toBe('rate_limited');
    });

    it('classifies a structured 403 with reason "blocked_word"', () => {
        const err = makeError(403, {error: 'automod_blocked', reason: 'blocked_word'});
        expect(classifyAutoModError(err)).toBe('blocked_word');
    });

    it('falls back to "blocked_word" for an unknown or missing reason', () => {
        const unknownReason = makeError(403, {error: 'automod_blocked', reason: 'something_new'});
        const missingReason = makeError(403, {error: 'automod_blocked'});
        expect(classifyAutoModError(unknownReason)).toBe('blocked_word');
        expect(classifyAutoModError(missingReason)).toBe('blocked_word');
    });

    it('returns null for a bare 403 with no body', () => {
        const err = makeError(403, null);
        expect(classifyAutoModError(err)).toBeNull();
    });

    it('returns null for a 403 with a different error marker (ordinary permission failure)', () => {
        const err = makeError(403, {error: 'forbidden'});
        expect(classifyAutoModError(err)).toBeNull();
    });

    it('returns null for a non-403 error', () => {
        const err = makeError(500, {error: 'automod_blocked', reason: 'blocked_word'});
        expect(classifyAutoModError(err)).toBeNull();
    });

    it('returns null when given null or undefined', () => {
        expect(classifyAutoModError(null)).toBeNull();
        expect(classifyAutoModError(undefined)).toBeNull();
    });
});

function chan(over: Partial<ChannelDto> & {id: string; type: ChannelType}): ChannelDto {
    return {
        createdAt: new Date(), updatedAt: new Date(), name: over.id, description: '',
        guildId: 'g1', isAgeRestricted: false, isPrivate: false, categoryId: undefined,
        permissions: [], position: 0, parentChannelId: undefined, ...over,
    } as ChannelDto;
}

describe('forumParentOf', () => {
    const forum = chan({id: 'f1', type: ChannelType.Forum});
    const media = chan({id: 'm1', type: ChannelType.Media});
    const text = chan({id: 't1', type: ChannelType.Text});
    const all = [forum, media, text];

    it('resolves a thread whose parent is a Forum', () => {
        const post = chan({id: 'p1', type: ChannelType.Thread, parentChannelId: 'f1'});
        expect(forumParentOf(post, all)).toBe(forum);
    });

    it('resolves a thread whose parent is a Media channel', () => {
        const post = chan({id: 'p2', type: ChannelType.Thread, parentChannelId: 'm1'});
        expect(forumParentOf(post, all)).toBe(media);
    });

    it('returns null for a thread whose parent is a Text channel', () => {
        const post = chan({id: 'p3', type: ChannelType.Thread, parentChannelId: 't1'});
        expect(forumParentOf(post, all)).toBeNull();
    });

    it('returns null for a channel that is not a Thread', () => {
        expect(forumParentOf(text, all)).toBeNull();
        expect(forumParentOf(forum, all)).toBeNull();
    });

    it('returns null when parentChannelId is absent', () => {
        const orphan = chan({id: 'p4', type: ChannelType.Thread});
        expect(forumParentOf(orphan, all)).toBeNull();
    });

    // A post can arrive before its parent is in the cached channel list; that must be a
    // null, not a crash, or the whole main view fails to render.
    it('returns null for a dangling parentChannelId', () => {
        const post = chan({id: 'p5', type: ChannelType.Thread, parentChannelId: 'gone'});
        expect(forumParentOf(post, all)).toBeNull();
    });

    it('returns null against an empty channel list', () => {
        const post = chan({id: 'p6', type: ChannelType.Thread, parentChannelId: 'f1'});
        expect(forumParentOf(post, [])).toBeNull();
    });
});
