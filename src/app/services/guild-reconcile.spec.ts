import {describe, expect, it} from 'vitest';
import {reconcileGuilds} from './guild-reconcile';
import {ChannelDto, ChannelType, GuildDto} from '../dtos/response/guild.dto';

const ISO = '2026-08-13T09:41:22.123Z';

function channel(id: string, name = id): ChannelDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name,
        description: '',
        type: ChannelType.Text,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
    };
}

function guild(id: string, channels: ChannelDto[], name = `Guild ${id}`): GuildDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name,
        description: '',
        ownerId: 'owner',
        categories: [],
        channels,
        roles: [],
        systemChannelId: null,
    };
}

/** The same guild as it would arrive off the wire: structurally equal, every object brand new. */
function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

describe('reconcileGuilds identity preservation', () => {
    /**
     * The point of the whole exercise. `guild-member-list` refetches its entire member page from
     * `ngOnChanges(changes['guild'])`, and five effects in `channel-list` and `channel` key off
     * `guild()`. Handing them a new object for a guild that did not change makes the cache cost
     * more than it saves.
     */
    it('keeps the existing object for a guild that did not change', () => {
        const current = [guild('g1', [channel('c1')])];
        const next = reconcileGuilds(current, clone(current));
        expect(next[0]).toBe(current[0]);
    });

    it('keeps the array itself when nothing at all changed, so a signal set is a no-op', () => {
        const current = [guild('g1', [channel('c1')]), guild('g2', [channel('c2')])];
        expect(reconcileGuilds(current, clone(current))).toBe(current);
    });

    it('gives a new object to a guild whose channels changed', () => {
        const current = [guild('g1', [channel('c1', 'general')])];
        const incoming = clone(current);
        incoming[0].channels[0].name = 'renamed';

        const next = reconcileGuilds(current, incoming);
        expect(next[0]).not.toBe(current[0]);
        expect(next[0].channels[0].name).toBe('renamed');
    });

    it('gives a new object to a guild whose own fields changed', () => {
        const current = [guild('g1', [channel('c1')], 'Old Name')];
        const incoming = clone(current);
        incoming[0].name = 'New Name';

        expect(reconcileGuilds(current, incoming)[0]).not.toBe(current[0]);
    });

    /**
     * Nested preservation, so renaming one channel does not hand every other channel - and the one
     * the user is currently reading - a fresh identity as collateral.
     */
    it('keeps the identity of sibling channels when one of them changed', () => {
        const keep = channel('c1');
        const current = [guild('g1', [keep, channel('c2', 'general')])];
        const incoming = clone(current);
        incoming[0].channels[1].name = 'renamed';

        const next = reconcileGuilds(current, incoming);
        expect(next[0].channels[0]).toBe(keep);
        expect(next[0].channels[1]).not.toBe(current[0].channels[1]);
    });

    it('keeps unchanged guilds when a different guild changed', () => {
        const current = [guild('g1', [channel('c1')]), guild('g2', [channel('c2')])];
        const incoming = clone(current);
        incoming[1].name = 'Renamed';

        const next = reconcileGuilds(current, incoming);
        expect(next[0]).toBe(current[0]);
        expect(next[1]).not.toBe(current[1]);
    });

    it('keeps unchanged guilds when a new one is added', () => {
        const current = [guild('g1', [channel('c1')])];
        const incoming = [...clone(current), guild('g2', [channel('c2')])];

        const next = reconcileGuilds(current, incoming);
        expect(next).toHaveLength(2);
        expect(next[0]).toBe(current[0]);
    });

    it('drops a guild that is no longer in the list', () => {
        const current = [guild('g1', [channel('c1')]), guild('g2', [channel('c2')])];
        const next = reconcileGuilds(current, [clone(current[0])]);
        expect(next.map(g => g.id)).toEqual(['g1']);
        expect(next[0]).toBe(current[0]);
    });

    it('follows a reorder while keeping the objects it reordered', () => {
        const current = [guild('g1', [channel('c1')]), guild('g2', [channel('c2')])];
        const next = reconcileGuilds(current, [clone(current[1]), clone(current[0])]);

        expect(next.map(g => g.id)).toEqual(['g2', 'g1']);
        expect(next[0]).toBe(current[1]);
        expect(next[1]).toBe(current[0]);
        expect(next).not.toBe(current);
    });

    /**
     * The cold-start case specifically. What is already in the signal came out of the cache with
     * revived `Date`s; what just landed carries the server's date strings. Those describe the same
     * instant, and a comparison that called them different would defeat the cache on every launch.
     */
    it('treats a revived Date and the server string for the same instant as unchanged', () => {
        const current = [guild('g1', [channel('c1')])];
        const incoming = clone(current) as unknown as GuildDto[];
        // `clone` already produced ISO strings; make sure the offset-carrying .NET form matches too.
        (incoming[0] as unknown as Record<string, unknown>)['createdAt'] = '2026-08-13T09:41:22.1230000+00:00';

        expect(reconcileGuilds(current, incoming)).toBe(current);
    });

    it('leaves the incoming list alone when there is nothing cached yet', () => {
        const incoming = [guild('g1', [channel('c1')])];
        expect(reconcileGuilds([], incoming)[0]).toBe(incoming[0]);
    });
});
