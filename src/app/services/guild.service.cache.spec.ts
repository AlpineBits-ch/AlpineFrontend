import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {GuildService} from './guild.service';
import {ApiConfigService} from './api-config.service';
import {ACTIVE_SLOT_KEY} from './scoped-oauth-storage';
import {guildLayoutCacheKey, readGuildLayoutCache, writeGuildLayoutCache} from './guild-layout-cache';
import {ChannelDto, ChannelType, GuildDto} from '../dtos/response/guild.dto';

const BASE = 'https://api.test.example/api/v1/guild';
const SLOT = 'slot-a';
const ISO = '2026-08-13T09:41:22.123Z';

let store: Map<string, string>;
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function installStorage(): void {
    store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
    store.set(ACTIVE_SLOT_KEY, SLOT);
}

function channel(id: string, guildId: string, name = id): ChannelDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name,
        description: '',
        type: ChannelType.Text,
        guildId,
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
    };
}

function guild(id: string, name = `Guild ${id}`): GuildDto {
    return {
        id,
        createdAt: new Date(ISO),
        updatedAt: new Date(ISO),
        name,
        description: '',
        ownerId: 'owner',
        categories: [],
        channels: [channel(`${id}_c1`, id)],
        roles: [],
        systemChannelId: null,
    };
}

/** The same guild as it arrives over HTTP: structurally equal, dates as strings, all new objects. */
function wire<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(GuildService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

beforeEach(() => {
    TestBed.resetTestingModule();
    installStorage();
});

afterEach(() => {
    try {
        TestBed.inject(HttpTestingController).verify();
    } finally {
        TestBed.resetTestingModule();
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
});

describe('GuildService cold start', () => {
    /**
     * The bug this exists for: the server rail, the channel list and the channel itself were all
     * blocked on one network response before anything painted.
     */
    it('exposes the cached guilds the moment it is constructed, with nothing on the wire', () => {
        writeGuildLayoutCache([guild('g1'), guild('g2')]);

        const {service, ctrl} = setup();

        expect(service.guilds().map(g => g.id)).toEqual(['g1', 'g2']);
        ctrl.expectNone(`${BASE}/guilds`);
    });

    it('hands back real Date instances from the cache, not the strings JSON.parse produces', () => {
        writeGuildLayoutCache([guild('g1')]);

        const {service} = setup();

        expect(service.guilds()[0].createdAt).toBeInstanceOf(Date);
        expect(service.guilds()[0].channels[0].updatedAt).toBeInstanceOf(Date);
    });

    it('starts empty when the cached blob is corrupt, rather than failing to construct', () => {
        store.set(guildLayoutCacheKey(SLOT), '{"v":1,"guilds":[{"id":');

        const {service} = setup();

        expect(service.guilds()).toEqual([]);
    });

    it('starts empty when another account wrote the cache', () => {
        writeGuildLayoutCache([guild('g1')]);
        store.set(ACTIVE_SLOT_KEY, 'slot-b');

        const {service} = setup();

        expect(service.guilds()).toEqual([]);
    });
});

describe('GuildService.getGuilds reconciliation', () => {
    it('keeps the object identity of a guild the response did not change', () => {
        writeGuildLayoutCache([guild('g1'), guild('g2')]);
        const {service, ctrl} = setup();
        const before = service.guilds();

        service.getGuilds().subscribe();
        ctrl.expectOne(`${BASE}/guilds`).flush(wire([guild('g1'), guild('g2')]));

        expect(service.guilds()).toBe(before);
    });

    it('replaces the object for a guild whose channels changed, and only that one', () => {
        writeGuildLayoutCache([guild('g1'), guild('g2')]);
        const {service, ctrl} = setup();
        const before = service.guilds();

        const fresh = [guild('g1'), guild('g2')];
        fresh[1].channels[0].name = 'renamed';
        service.getGuilds().subscribe();
        ctrl.expectOne(`${BASE}/guilds`).flush(wire(fresh));

        expect(service.guilds()[0]).toBe(before[0]);
        expect(service.guilds()[1]).not.toBe(before[1]);
        expect(service.guilds()[1].channels[0].name).toBe('renamed');
    });

    /**
     * Subscribers have to get the same objects the signal holds. Handing them the raw response
     * instead would put a second identity for the same guild into `NavigationService.workspace`,
     * which is precisely the cascade this change removes.
     */
    it('emits the reconciled list, not the raw response', () => {
        writeGuildLayoutCache([guild('g1')]);
        const {service, ctrl} = setup();

        let emitted: GuildDto[] | undefined;
        service.getGuilds().subscribe(g => (emitted = g));
        ctrl.expectOne(`${BASE}/guilds`).flush(wire([guild('g1')]));

        expect(emitted![0]).toBe(service.guilds()[0]);
    });

    it('writes the response to the cache for the next cold start', () => {
        const {service, ctrl} = setup();

        service.getGuilds().subscribe();
        ctrl.expectOne(`${BASE}/guilds`).flush(wire([guild('g1'), guild('g2')]));

        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['g1', 'g2']);
        expect(service.guilds()).toHaveLength(2);
    });

    it('revives the response dates too, so the cached and fetched shapes agree', () => {
        const {service, ctrl} = setup();

        service.getGuilds().subscribe();
        ctrl.expectOne(`${BASE}/guilds`).flush(wire([guild('g1')]));

        expect(service.guilds()[0].createdAt).toBeInstanceOf(Date);
    });

    it('records a guild that has gone away', () => {
        writeGuildLayoutCache([guild('g1'), guild('g2')]);
        const {service, ctrl} = setup();

        service.getGuilds().subscribe();
        ctrl.expectOne(`${BASE}/guilds`).flush(wire([guild('g1')]));

        expect(service.guilds().map(g => g.id)).toEqual(['g1']);
        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['g1']);
    });
});

describe('GuildService single source of truth', () => {
    it('upsertGuild adds a guild that is not there yet', () => {
        const {service} = setup();
        service.upsertGuild(guild('g1'));
        expect(service.guilds().map(g => g.id)).toEqual(['g1']);
        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['g1']);
    });

    it('upsertGuild replaces in place rather than appending a duplicate', () => {
        writeGuildLayoutCache([guild('g1'), guild('g2')]);
        const {service} = setup();

        service.upsertGuild(guild('g1', 'Renamed'));

        expect(service.guilds().map(g => g.id)).toEqual(['g1', 'g2']);
        expect(service.guilds()[0].name).toBe('Renamed');
    });

    /**
     * The WS `guildUpdated` path refetches the whole guild and republishes it even when nothing a
     * component cares about moved. Without this the rail, the channel list and the member list all
     * tear down and refetch on a heartbeat-shaped event.
     */
    it('upsertGuild with an identical guild changes nothing', () => {
        writeGuildLayoutCache([guild('g1')]);
        const {service} = setup();
        const before = service.guilds();

        service.upsertGuild(wire(guild('g1')));

        expect(service.guilds()).toBe(before);
    });

    it('removeGuild drops it from the signal and the cache', () => {
        writeGuildLayoutCache([guild('g1'), guild('g2')]);
        const {service} = setup();

        service.removeGuild('g1');

        expect(service.guilds().map(g => g.id)).toEqual(['g2']);
        expect(readGuildLayoutCache().map(g => g.id)).toEqual(['g2']);
    });

    it('removeGuild for a guild that is not there changes nothing', () => {
        writeGuildLayoutCache([guild('g1')]);
        const {service} = setup();
        const before = service.guilds();

        service.removeGuild('nope');

        expect(service.guilds()).toBe(before);
    });

    it('forgetCachedGuilds empties the signal and the stored blob', () => {
        writeGuildLayoutCache([guild('g1')]);
        const {service} = setup();

        service.forgetCachedGuilds();

        expect(service.guilds()).toEqual([]);
        expect(store.has(guildLayoutCacheKey(SLOT))).toBe(false);
    });
});
