import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
import {ChannelReadState} from '../../../../../../services/guild-read-state.service';
import {MAX_NESTED_POST_ROWS, selectNestedPosts} from './forum-post-rows.util';

function post(over: Partial<ChannelDto> & {id: string}): ChannelDto {
    return {
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
        name: over.id,
        description: '',
        type: ChannelType.Thread,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: 'f1',
        ...over,
    } as ChannelDto;
}

/** Read state for the named ids; everything else is read with no mentions. */
function reader(states: Record<string, Partial<ChannelReadState>>) {
    return (id: string): ChannelReadState => ({
        isUnread: false,
        mentionCount: 0,
        ...(states[id] ?? {}),
    });
}

const quiet = reader({});

describe('selectNestedPosts', () => {
    it('returns nothing for a forum whose posts are neither visited nor active', () => {
        const all = [post({id: 'p1'}), post({id: 'p2'})];

        expect(selectNestedPosts('f1', all, [], quiet)).toEqual([]);
    });

    it('ignores posts belonging to another forum', () => {
        const all = [post({id: 'mine'}), post({id: 'theirs', parentChannelId: 'f2'})];

        const rows = selectNestedPosts('f1', all, ['mine', 'theirs'], quiet);

        expect(rows.map(p => p.id)).toEqual(['mine']);
    });

    it('includes a post because it was visited, because it is unread, or because it mentions you', () => {
        const all = [post({id: 'visited'}), post({id: 'unread'}), post({id: 'mentioned'}), post({id: 'ignored'})];
        const read = reader({unread: {isUnread: true}, mentioned: {mentionCount: 2}});

        const rows = selectNestedPosts('f1', all, ['visited'], read);

        expect(rows.map(p => p.id).sort()).toEqual(['mentioned', 'unread', 'visited']);
    });

    /** An archived post has left the forum's default list, so a row pointing at one would open a post the user can't find again by browsing. */
    it('excludes an archived post even when it is unread and was visited', () => {
        const all = [post({id: 'gone', isArchived: true})];
        const read = reader({gone: {isUnread: true, mentionCount: 3}});

        expect(selectNestedPosts('f1', all, ['gone'], read)).toEqual([]);
    });

    it('orders mentioned before unread before visited', () => {
        const all = [post({id: 'visited'}), post({id: 'unread'}), post({id: 'mentioned'})];
        const read = reader({unread: {isUnread: true}, mentioned: {mentionCount: 1}});

        const rows = selectNestedPosts('f1', all, ['visited'], read);

        expect(rows.map(p => p.id)).toEqual(['mentioned', 'unread', 'visited']);
    });

    it('breaks ties on most recent activity', () => {
        const all = [
            post({id: 'older', lastActivityAt: '2026-07-01T00:00:00Z'}),
            post({id: 'newest', lastActivityAt: '2026-07-30T00:00:00Z'}),
            post({id: 'middle', lastActivityAt: '2026-07-15T00:00:00Z'}),
        ];

        const rows = selectNestedPosts('f1', all, ['older', 'newest', 'middle'], quiet);

        expect(rows.map(p => p.id)).toEqual(['newest', 'middle', 'older']);
    });

    /** lastActivityAt is absent until someone posts, and on every pre-deploy thread. */
    it('falls back to createdAt when a post has no activity yet', () => {
        const all = [
            post({id: 'newer', createdAt: new Date('2026-07-20T00:00:00Z')}),
            post({id: 'older', createdAt: new Date('2026-07-02T00:00:00Z')}),
        ];

        const rows = selectNestedPosts('f1', all, ['newer', 'older'], quiet);

        expect(rows.map(p => p.id)).toEqual(['newer', 'older']);
    });

    it('caps the rows and drops the least interesting first', () => {
        const all = [
            ...Array.from({length: 12}, (_, i) => post({id: `v${i}`, lastActivityAt: '2026-07-01T00:00:00Z'})),
            post({id: 'mentioned', lastActivityAt: '2026-06-01T00:00:00Z'}),
        ];
        const read = reader({mentioned: {mentionCount: 1}});

        const rows = selectNestedPosts('f1', all, all.map(p => p.id), read);

        expect(rows.length).toBe(MAX_NESTED_POST_ROWS);
        // Oldest of the lot, but the only one that named the user; it must survive the cut.
        expect(rows[0].id).toBe('mentioned');
    });
});
