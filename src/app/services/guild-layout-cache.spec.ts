import {afterEach, describe, expect, it} from 'vitest';
import {ACTIVE_SLOT_KEY} from './scoped-oauth-storage';
import {
    clearGuildLayoutCache,
    guildLayoutCacheKey,
    readGuildLayoutCache,
    writeGuildLayoutCache,
} from './guild-layout-cache';
import {CategoryDto, ChannelDto, ChannelType, GuildDto, RoleDto} from '../dtos/response/guild.dto';

/**
 * A stand-in for `localStorage`, because this runner's global has no methods - and because half of
 * what is being tested here is what happens when storage refuses to co-operate.
 */
interface FakeStorageOptions {
    /** Throws on every `setItem`, the way a browser signals a full quota. */
    quotaFull?: boolean;
    /** Throws on every `getItem`, the way a locked-down profile refuses storage outright. */
    readThrows?: boolean;
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function installStorage(opts: FakeStorageOptions = {}): Map<string, string> {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => {
                if (opts.readThrows) throw new DOMException('denied', 'SecurityError');
                return store.get(k) ?? null;
            },
            setItem: (k: string, v: string) => {
                if (opts.quotaFull) throw new DOMException('full', 'QuotaExceededError');
                store.set(k, String(v));
            },
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
    return store;
}

function removeStorage(): void {
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: undefined});
}

afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: undefined});
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ISO = '2026-08-13T09:41:22.123Z';

function channel(id: string, guildId = 'g1'): ChannelDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name: id,
        description: '',
        type: ChannelType.Text,
        guildId,
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [{
            id: `perm_${id}`,
            createdAt: new Date(ISO),
            updatedAt: new Date(ISO),
            channelId: id,
            roleId: 'r1',
            memberId: undefined,
            categoryId: undefined,
            allowPermissions: 'ViewChannel',
            denyPermissions: 'None',
        }],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
    };
}

function category(id: string): CategoryDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name: id,
        description: '',
        permissions: [],
        position: 0,
    };
}

function role(id: string, guildId = 'g1'): RoleDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name: id,
        description: '',
        color: '#7c72ff',
        guildId,
        userId: 'u1',
        permissions: 'ViewChannel',
        type: 'None',
        position: 0,
    } as RoleDto;
}

function guild(id: string, channels = [channel('c1', id)]): GuildDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name: `Guild ${id}`,
        description: '',
        ownerId: 'owner',
        categories: [category(`cat_${id}`)],
        channels,
        roles: [role(`role_${id}`, id)],
        systemChannelId: null,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('guild layout cache round trip', () => {
    it('reads back what it wrote for the live slot', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');

        writeGuildLayoutCache([guild('g1'), guild('g2')]);

        const read = readGuildLayoutCache();
        expect(read.map(g => g.id)).toEqual(['g1', 'g2']);
        expect(read[0].channels.map(c => c.id)).toEqual(['c1']);
    });

    it('writes under the slot-scoped key and nowhere else', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');

        writeGuildLayoutCache([guild('g1')]);

        expect(store.has(guildLayoutCacheKey('slot-a'))).toBe(true);
    });

    it('answers with an empty list when nothing has been written', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        expect(readGuildLayoutCache()).toEqual([]);
    });
});

describe('guild layout cache date revival', () => {
    /**
     * The whole reason revival is explicit. `GuildDto` declares these as `Date`, `JSON.parse` hands
     * back strings, and TypeScript keeps insisting otherwise - so the lie surfaces at whatever call
     * site first treats one as a `Date`, which is nowhere near here.
     */
    it('brings createdAt and updatedAt back as real Date instances at every level', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        writeGuildLayoutCache([guild('g1')]);

        const [g] = readGuildLayoutCache();

        expect(g.createdAt).toBeInstanceOf(Date);
        expect(g.updatedAt).toBeInstanceOf(Date);
        expect(g.channels[0].createdAt).toBeInstanceOf(Date);
        expect(g.channels[0].permissions[0].updatedAt).toBeInstanceOf(Date);
        expect(g.categories[0].createdAt).toBeInstanceOf(Date);
        expect(g.roles[0].updatedAt).toBeInstanceOf(Date);
        expect(g.createdAt.getTime()).toBe(new Date(ISO).getTime());
    });

    it('leaves an unparseable date alone rather than producing an Invalid Date', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        store.set(guildLayoutCacheKey('slot-a'), JSON.stringify({
            v: 1,
            guilds: [{...guild('g1'), createdAt: 'not a date'}],
        }));

        const [g] = readGuildLayoutCache();
        expect(g.createdAt).toBe('not a date' as unknown as Date);
    });
});

describe('guild layout cache account scoping', () => {
    /**
     * Load-bearing, not a nicety: cached channel names are one account's private membership list.
     * Rendering them while a different account is signed in is a confidentiality bug.
     */
    it('does not answer for slot B with what slot A wrote', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        writeGuildLayoutCache([guild('secret')]);

        store.set(ACTIVE_SLOT_KEY, 'slot-b');
        expect(readGuildLayoutCache()).toEqual([]);
    });

    it('keeps both slots side by side', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        writeGuildLayoutCache([guild('ga')]);
        store.set(ACTIVE_SLOT_KEY, 'slot-b');
        writeGuildLayoutCache([guild('gb')]);

        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['ga']);
        store.set(ACTIVE_SLOT_KEY, 'slot-b');
        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['gb']);
    });

    it('clears only the named slot', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        writeGuildLayoutCache([guild('ga')]);
        store.set(ACTIVE_SLOT_KEY, 'slot-b');
        writeGuildLayoutCache([guild('gb')]);

        clearGuildLayoutCache('slot-a');

        expect(store.has(guildLayoutCacheKey('slot-a'))).toBe(false);
        expect(store.has(guildLayoutCacheKey('slot-b'))).toBe(true);
    });

    it('clears the live slot when called with no argument', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        writeGuildLayoutCache([guild('ga')]);

        clearGuildLayoutCache();

        expect(readGuildLayoutCache()).toEqual([]);
    });
});

describe('guild layout cache failing soft', () => {
    it('reads empty from a truncated blob rather than throwing', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        store.set(guildLayoutCacheKey('slot-a'), '{"v":1,"guilds":[{"id":"g1","chan');

        expect(readGuildLayoutCache()).toEqual([]);
    });

    it('reads empty from a blob written by a different cache version', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        store.set(guildLayoutCacheKey('slot-a'), JSON.stringify({v: 99, guilds: [guild('g1')]}));

        expect(readGuildLayoutCache()).toEqual([]);
    });

    it('reads empty when the envelope is the right shape but the payload is not a list', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        store.set(guildLayoutCacheKey('slot-a'), JSON.stringify({v: 1, guilds: 'nope'}));

        expect(readGuildLayoutCache()).toEqual([]);
    });

    /** Consumers do `g.channels.reduce(...)` unguarded, so a half-shaped entry must never reach them. */
    it('drops entries that are missing the arrays every consumer indexes into', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        store.set(guildLayoutCacheKey('slot-a'), JSON.stringify({
            v: 1,
            guilds: [{id: 'broken', name: 'Broken'}, guild('ok')],
        }));

        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['ok']);
    });

    it('swallows a quota error on write', () => {
        const store = installStorage({quotaFull: true});
        store.set(ACTIVE_SLOT_KEY, 'slot-a');

        expect(() => writeGuildLayoutCache([guild('g1')])).not.toThrow();
    });

    it('reads empty when storage refuses to answer at all', () => {
        installStorage({readThrows: true});
        expect(readGuildLayoutCache()).toEqual([]);
    });

    it('does not throw when there is no storage object at all', () => {
        removeStorage();
        expect(readGuildLayoutCache()).toEqual([]);
        expect(() => writeGuildLayoutCache([guild('g1')])).not.toThrow();
        expect(() => clearGuildLayoutCache()).not.toThrow();
    });
});

describe('guild layout cache size cap', () => {
    /**
     * An account with a hundred servers serializes to megabytes, and localStorage is a ~5 MiB
     * budget shared with the tokens, the nav position and every settings blob. Overflowing it
     * would not just lose this cache; the write that fails could be somebody else's.
     */
    it('keeps a prefix of the list rather than writing a blob that would not fit', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');

        // Each guild carries enough channels to make a hundred of them exceed any sane cap.
        const fat = Array.from({length: 200}, (_, i) =>
            guild(`g${i}`, Array.from({length: 60}, (_, c) => channel(`c${i}_${c}`, `g${i}`))));

        writeGuildLayoutCache(fat);

        const read = readGuildLayoutCache();
        expect(read.length).toBeGreaterThan(0);
        expect(read.length).toBeLessThan(fat.length);
        // A prefix, so the list stays in the server's order rather than an arbitrary subset.
        expect(read.map(g => g.id)).toEqual(fat.slice(0, read.length).map(g => g.id));
        expect(store.get(guildLayoutCacheKey('slot-a'))!.length).toBeLessThan(1_000_000);
    });

    it('writes a normal-sized list untouched', () => {
        const store = installStorage();
        store.set(ACTIVE_SLOT_KEY, 'slot-a');
        const list = Array.from({length: 12}, (_, i) => guild(`g${i}`));

        writeGuildLayoutCache(list);

        expect(readGuildLayoutCache()).toHaveLength(12);
    });
});
