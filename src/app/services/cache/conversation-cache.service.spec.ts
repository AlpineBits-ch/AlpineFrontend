import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../enums/conversation-encryption.enum';
import {CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {ConversationCacheService, CONVERSATION_LIST_KEY} from './conversation-cache.service';

function conversation(id: string, updatedAt: Date): ConversationDto {
    return {
        id,
        createdAt: new Date(0),
        updatedAt,
        name: `conv ${id}`,
        iconUpdatedAt: null,
        encryptionState: ConversationEncryption.Plain,
        members: [
            {
                id: `m-${id}`,
                createdAt: new Date(0),
                updatedAt: new Date(0),
                userId: 'u1',
                cachedUserName: 'user one',
                lastReadMessageId: undefined,
                mentionCount: 0,
            },
        ],
    };
}

class FakeCacheStore {
    readonly entries = new Map<string, unknown>();
    async get(_d: string, key: string) {
        return this.entries.get(key);
    }
    async set(_d: string, key: string, value: unknown) {
        this.entries.set(key, value);
    }
    async delete(_d: string, key: string) {
        this.entries.delete(key);
    }
    async all<T>() {
        return [...this.entries.entries()] as [string, T][];
    }
    async clear() {
        this.entries.clear();
    }
    sizeOf() {
        return 0;
    }
}

let cache: FakeCacheStore;
let subject: ConversationCacheService;
let deviceId: string;
let opened: string[];

/** Forces the round trip through JSON, which is what strips the Date types on a real reload. */
function throughDisk(): void {
    cache.entries.set(
        CONVERSATION_LIST_KEY,
        JSON.parse(JSON.stringify(cache.entries.get(CONVERSATION_LIST_KEY))),
    );
}

describe('ConversationCacheService', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        cache = new FakeCacheStore();
        deviceId = 'device-a';
        opened = [];
        TestBed.configureTestingModule({
            providers: [
                {
                    provide: CacheStoreFactory,
                    useValue: {
                        open: (id: string) => {
                            opened.push(id);
                            return cache;
                        },
                    },
                },
                {provide: DeviceIdentityService, useValue: {deviceId: async () => deviceId}},
            ],
        });
        subject = TestBed.inject(ConversationCacheService);
    });

    it('round-trips a conversation', async () => {
        await subject.remember([conversation('c1', new Date(5))]);

        const [recalled] = await subject.recall();
        expect(recalled.id).toBe('c1');
        expect(recalled.name).toBe('conv c1');
        expect(recalled.members[0].userId).toBe('u1');
    });

    it('revives the dates the list sorts on', async () => {
        await subject.remember([conversation('c1', new Date(5))]);
        throughDisk();

        const [recalled] = await subject.recall();
        // sortedConversations calls new Date(updatedAt).getTime(); a member date reaches
        // cacheBustedUrl, which calls .getTime() directly and throws on a string.
        expect(recalled.updatedAt).toBeInstanceOf(Date);
        expect(recalled.createdAt).toBeInstanceOf(Date);
        expect(recalled.members[0].updatedAt).toBeInstanceOf(Date);
    });

    it('keeps only the newest page', async () => {
        const many = Array.from({length: 30}, (_, i) => conversation(`c${i}`, new Date(i)));
        await subject.remember(many);

        const recalled = await subject.recall();
        expect(recalled).toHaveLength(20);
        expect(recalled.map(c => c.id)).toContain('c29');
        expect(recalled.map(c => c.id)).not.toContain('c0');
    });

    it('recalls nothing when the cache is cold', async () => {
        expect(await subject.recall()).toEqual([]);
    });

    it('forgets an empty list rather than storing one', async () => {
        await subject.remember([conversation('c1', new Date(5))]);
        await subject.remember([]);

        expect(cache.entries.has(CONVERSATION_LIST_KEY)).toBe(false);
    });

    it('follows the device id across a sign-out', async () => {
        await subject.remember([conversation('c1', new Date(5))]);
        deviceId = 'device-b';
        await subject.recall();

        expect(opened).toEqual(['device-a', 'device-b']);
    });
});
