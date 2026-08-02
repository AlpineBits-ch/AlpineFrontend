import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {classifyAutoModError, forumParentOf, mayPostCleartext} from './channel-utils';

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

describe('mayPostCleartext', () => {
    it('allows cleartext in a channel that is genuinely plaintext', () => {
        expect(mayPostCleartext(null, 'plain')).toBe(true);
    });

    it('refuses cleartext when the channel is encrypted and we cannot participate', () => {
        // The bug this exists for: holding no local generation looked exactly like "not
        // encrypted", so the composer posted the message in the clear. The server refuses it -
        // but only after the plaintext has already left the machine.
        expect(mayPostCleartext(null, 'locked-out')).toBe(false);
    });

    it('refuses cleartext when we are in the group but have no generation recorded', () => {
        // A torn registry write or a wipe mid-session lands here. Sending plaintext into an
        // encrypted channel is never the safe interpretation of an inconsistent local state.
        expect(mayPostCleartext(null, 'joined')).toBe(false);
    });

    it('refuses cleartext whenever a generation is held, whatever the resolved state says', () => {
        // Holding a generation is direct evidence the channel is encrypted for this device, and it
        // outranks a resolved state that may simply be stale.
        expect(mayPostCleartext(1, 'plain')).toBe(false);
        expect(mayPostCleartext(0, 'plain')).toBe(false);
    });

    // ─── C1: the monotonic encryption floor vetoes everything else ────────────
    //
    // Both arguments above are downstream of a server field. A server answering
    // `{encrypted: false}` for a channel this device had been encrypting to got the active
    // generation cleared and the resolved state set to 'plain' - so both inputs said "cleartext is
    // fine" and the next composed message went out in the clear, with no group keys involved and
    // no MLS property broken.

    it('refuses cleartext in any channel this device has ever encrypted', () => {
        // Generation cleared, state resolved to plain, and still refused: the floor is the only
        // input here the server cannot move.
        expect(mayPostCleartext(null, 'plain', 2)).toBe(false);
    });

    it('treats generation zero as a floor, not as absent', () => {
        // The first generation of a context is 0, and `0` is falsy. A truthiness check here would
        // exempt precisely the contexts that have only ever had one encrypted era.
        expect(mayPostCleartext(null, 'plain', 0)).toBe(false);
    });

    it('still allows cleartext where no floor was ever set', () => {
        // The floor must not turn every plaintext channel into a refusal - a veto that fires
        // everywhere is one that gets removed.
        expect(mayPostCleartext(null, 'plain', null)).toBe(true);
    });

    it('refuses cleartext in the state a claimed downgrade resolves to', () => {
        expect(mayPostCleartext(null, 'downgraded')).toBe(false);
    });
});
