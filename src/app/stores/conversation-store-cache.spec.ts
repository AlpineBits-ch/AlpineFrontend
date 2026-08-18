import {TestBed} from '@angular/core/testing';
import {Subject, of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ConversationStore} from './conversation.store';
import {ConversationService} from '../services/conversation.service';
import {MessagingWebsocketService} from '../services/messaging-websocket.service';
import {ProfileService} from '../services/profile.service';
import {ConversationCacheService} from '../services/cache/conversation-cache.service';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {ConversationEncryption} from '../enums/conversation-encryption.enum';

function conversation(id: string, updatedAt = new Date(1)): ConversationDto {
    return {
        id,
        createdAt: new Date(0),
        updatedAt,
        name: `conv ${id}`,
        iconUpdatedAt: null,
        encryptionState: ConversationEncryption.Plain,
        members: [],
    };
}

function setup(cached: ConversationDto[] = []) {
    const conversations$ = new Subject<ConversationDto[]>();
    const service = {
        getConversations: vi.fn(() => conversations$),
        getConversationById: vi.fn(() => of(conversation('unused'))),
    };
    const cache = {
        recall: vi.fn(async () => cached),
        remember: vi.fn(async () => undefined),
        forget: vi.fn(async () => undefined),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {provide: ConversationService, useValue: service},
            {provide: ConversationCacheService, useValue: cache},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'u1'})}},
            {
                provide: MessagingWebsocketService,
                useValue: {
                    conversationCreatedObservable: new Subject(),
                    messageObservable: new Subject(),
                    conversationRemovedObservable: new Subject(),
                    conversationUpdatedObservable: new Subject(),
                    conversationMemberRemovedObservable: new Subject(),
                },
            },
        ],
    });

    return {store: TestBed.inject(ConversationStore), service, cache, conversations$};
}

/**
 * Pins what makes the DM list appear with the splash rather than a round trip after it: the store
 * can be filled from disk, and doing so must not stand in the way of the network copy.
 */
describe('ConversationStore hydration', () => {
    beforeEach(() => vi.useRealTimers());

    it('fills the store from the cache', async () => {
        const {store} = setup([conversation('c1'), conversation('c2')]);

        expect(await store.hydrate()).toBe(2);
        expect(store.entities().map(c => c.id)).toEqual(['c1', 'c2']);
    });

    it('leaves loaded false, so loadInitial still fetches', async () => {
        const {store, service} = setup([conversation('c1')]);

        await store.hydrate();
        expect(store.loaded()).toBe(false);

        store.loadInitial();
        expect(service.getConversations).toHaveBeenCalled();
    });

    it('does not clobber a network result that landed first', async () => {
        let release!: (convs: ConversationDto[]) => void;
        const cached = new Promise<ConversationDto[]>(resolve => {
            release = resolve;
        });
        const {store, conversations$} = setup([]);
        TestBed.inject(ConversationCacheService).recall = () => cached;

        const hydrating = store.hydrate();
        store.loadInitial();
        conversations$.next([conversation('fresh')]);

        release([conversation('stale')]);
        expect(await hydrating).toBe(0);
        expect(store.entities().map(c => c.id)).toEqual(['fresh']);
    });

    it('reports nothing hydrated when the cache is cold', async () => {
        const {store} = setup([]);

        expect(await store.hydrate()).toBe(0);
        expect(store.entities()).toEqual([]);
    });
});

describe('ConversationStore forget', () => {
    beforeEach(() => vi.useRealTimers());

    it('drops the entities and lets loadInitial fetch again', () => {
        const {store, service, conversations$} = setup();

        store.loadInitial();
        conversations$.next([conversation('c1')]);
        expect(store.loaded()).toBe(true);

        store.forget();

        // Both halves matter: the next account must not see this list, and must not be locked out
        // of fetching its own by a loaded flag left true across an in-document sign-out.
        expect(store.entities()).toEqual([]);
        expect(store.loaded()).toBe(false);

        store.loadInitial();
        expect(service.getConversations).toHaveBeenCalledTimes(2);
    });
});

describe('ConversationStore write-behind', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('persists the list once it settles', async () => {
        const {store, cache, conversations$} = setup();

        store.loadInitial();
        conversations$.next([conversation('c1'), conversation('c2')]);
        TestBed.tick();
        await vi.runAllTimersAsync();

        expect(cache.remember).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({id: 'c1'})]),
        );
    });

    it('coalesces a burst into one write', async () => {
        const {store, cache, conversations$} = setup();

        store.loadInitial();
        conversations$.next([conversation('c1')]);
        TestBed.tick();
        store.bumpUpdatedAt('c1');
        TestBed.tick();
        store.bumpUpdatedAt('c1');
        TestBed.tick();
        await vi.runAllTimersAsync();

        // A bump lands on every incoming message; one disk write per message is what the debounce
        // exists to prevent.
        expect(cache.remember).toHaveBeenCalledTimes(1);
    });

    it('persists an emptied store, so a sign-out wipe is not undone by the write-behind', async () => {
        const {store, cache, conversations$} = setup();

        store.loadInitial();
        conversations$.next([conversation('c1')]);
        TestBed.tick();
        await vi.runAllTimersAsync();

        store.forget();
        TestBed.tick();
        await vi.runAllTimersAsync();

        // remember([]) deletes the row rather than writing one, which is why forget() needs no
        // separate 'stop persisting' flag: the last write after a sign-out is a removal.
        expect(cache.remember).toHaveBeenLastCalledWith([]);
    });

    it('survives a rejected write', async () => {
        const {store, cache, conversations$} = setup();
        cache.remember = vi.fn(async () => {
            throw new Error('quota');
        });

        store.loadInitial();
        conversations$.next([conversation('c1')]);
        TestBed.tick();

        // An unhandled rejection here reaches GlobalErrorHandler, which reloads the window after
        // three in five seconds.
        await expect(vi.runAllTimersAsync()).resolves.toBeDefined();
    });
});
