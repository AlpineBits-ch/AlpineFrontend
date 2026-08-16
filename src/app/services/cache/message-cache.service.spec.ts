import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {MessageDto} from '../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {MessageCacheService, messageContextKey} from './message-cache.service';

function message(id: string, state: MessageEncryptionState, content: string): MessageDto {
    return {
        id, conversationId: 'c1', channelId: undefined,
        authorId: 'u1', content, encryptionState: state,
        createdAt: new Date(0), updatedAt: new Date(0),
        attachments: [], reactions: [],
    } as unknown as MessageDto;
}

class FakeCacheStore {
    readonly entries = new Map<string, unknown>();
    async get(_d: string, key: string) { return this.entries.get(key); }
    async set(_d: string, key: string, value: unknown) { this.entries.set(key, value); }
    async delete(_d: string, key: string) { this.entries.delete(key); }
    async all<T>() { return [...this.entries.entries()] as [string, T][]; }
    async clear() { this.entries.clear(); }
    sizeOf() { return 0; }
}

let cache: FakeCacheStore;
let subject: MessageCacheService;

describe('MessageCacheService', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        cache = new FakeCacheStore();
        TestBed.configureTestingModule({
            providers: [
                {provide: CacheStoreFactory, useValue: {open: () => cache}},
                {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
            ],
        });
        subject = TestBed.inject(MessageCacheService);
    });

    it('builds distinct keys for a conversation and a channel', () => {
        expect(messageContextKey({conversationId: 'x'}))
            .not.toBe(messageContextKey({channelId: 'x'}));
    });

    it('round-trips an unencrypted message with its body intact', async () => {
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.Plain, 'hello')]);

        const [recalled] = await subject.recall('conv:c1');
        expect(recalled.content).toBe('hello');
    });

    it('drops the body of an encrypted message', async () => {
        // The plaintext already lives in the MLS cache, sealed and inside the backup envelope.
        // A second copy here would double it at rest for no gain.
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.Encrypted, 'Y2lwaGVy')]);

        const [recalled] = await subject.recall('conv:c1');
        expect(recalled.content).toBe('');
        expect(recalled.id).toBe('m1');
        expect(recalled.authorId).toBe('u1');
    });

    it('revives dates', async () => {
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.Plain, 'hello')]);
        cache.entries.set('conv:c1',
            JSON.parse(JSON.stringify(cache.entries.get('conv:c1'))));

        const [recalled] = await subject.recall('conv:c1');
        expect(recalled.createdAt).toBeInstanceOf(Date);
    });

    it('recalls nothing for a context it has never seen', async () => {
        expect(await subject.recall('conv:nope')).toEqual([]);
    });

    it('never caches a pending or failed message', async () => {
        // An optimistic message that never landed would come back from disk after a restart
        // looking exactly like a sent one.
        const pending = {...message('t1', MessageEncryptionState.Plain, 'draft'), isPending: true};
        await subject.remember('conv:c1', [pending as MessageDto]);

        expect(await subject.recall('conv:c1')).toEqual([]);
    });

    it('forget drops the context', async () => {
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.Plain, 'hello')]);
        await subject.forget('conv:c1');

        expect(await subject.recall('conv:c1')).toEqual([]);
    });
});
