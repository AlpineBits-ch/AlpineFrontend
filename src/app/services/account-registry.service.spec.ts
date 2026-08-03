/**
 * The slot list: which accounts this installation holds, and which one is live.
 *
 * <p>Matching is on `{serverUrl, userId}` rather than on the username, and the tests pin that -
 * a rename must not strand the account's device id, MLS state and message history behind a slot
 * nothing looks up any more.</p>
 */
vi.mock('@tauri-apps/plugin-store', () => ({
    // Named, and self-referencing: the factory is hoisted above every module-level binding, so a
    // reference to anything declared below it is a ReferenceError at construction time.
    LazyStore: class LazyStoreStub {
        // Static, so two `new LazyStore('settings.json')` calls see one file - which is what the
        // real plugin does and what the service relies on when it re-opens the store per write.
        static readonly files = new Map<string, Map<string, unknown>>();

        private readonly values: Map<string, unknown>;

        constructor(file: string) {
            const existing = LazyStoreStub.files.get(file);
            this.values = existing ?? new Map<string, unknown>();
            LazyStoreStub.files.set(file, this.values);
        }

        async get<T>(key: string) { return this.values.get(key) as T | undefined; }
        async set(key: string, value: unknown) { this.values.set(key, value); }
        async delete(key: string) { this.values.delete(key); }
        async entries<T>() { return [...this.values.entries()] as [string, T][]; }
        async clear() { this.values.clear(); }
        async save() { }
    },
}));

import {TestBed} from '@angular/core/testing';
import {LazyStore} from '@tauri-apps/plugin-store';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from './account-registry.service';

const LazyStoreMock = LazyStore as unknown as {
    files: Map<string, Map<string, unknown>>;
};

function freshService(): AccountRegistryService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [AccountRegistryService]});
    return TestBed.inject(AccountRegistryService);
}

describe('AccountRegistryService', () => {
    let service: AccountRegistryService;

    beforeEach(() => {
        LazyStoreMock.files.clear();
        service = freshService();
    });

    it('reports the bootstrap slot before anyone has signed in', async () => {
        expect(await service.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(await service.activeSlot()).toBeNull();
        expect(await service.list()).toEqual([]);
    });

    it('creates a slot on first sign-in and makes it live', async () => {
        const slot = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(slot.userId).toBe('user-1');
        expect(await service.activeSlotId()).toBe(slot.id);
        expect(await service.list()).toHaveLength(1);
    });

    it('reuses the slot for an account it already holds', async () => {
        const first = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const again = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(again.id).toBe(first.id);
        expect(await service.list()).toHaveLength(1);
    });

    it('keeps the same account on two servers apart', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const b = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://b.example'});

        expect(b.id).not.toBe(a.id);
        expect(await service.list()).toHaveLength(2);
    });

    it('matches on the user id, not the username, so a rename keeps the slot', async () => {
        const before = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'old',
        });
        const after = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'new',
        });

        expect(after.id).toBe(before.id);
        expect(after.username).toBe('new');
    });

    it('does not blank a known username when a later sign-in carries none', async () => {
        await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'named',
        });
        const again = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(again.username).toBe('named');
    });

    it('fills in the display half from a profile patch', async () => {
        const slot = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        await service.updateProfile(slot.id, {username: 'ada', avatarUrl: 'https://img/a.png'});

        const [stored] = await service.list();
        expect(stored.username).toBe('ada');
        expect(stored.displayName).toBe('ada');
        expect(stored.avatarUrl).toBe('https://img/a.png');
    });

    it('clears an avatar when the patch says null, and leaves it alone when it says nothing', async () => {
        const slot = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', avatarUrl: 'https://img/a.png',
        });

        await service.updateProfile(slot.id, {username: 'ada'});
        expect((await service.list())[0].avatarUrl).toBe('https://img/a.png');

        await service.updateProfile(slot.id, {avatarUrl: null});
        expect((await service.list())[0].avatarUrl).toBeNull();
    });

    it('activates a known slot', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        await service.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});

        expect(await service.activate(a.id)).toBe(true);
        expect(await service.activeSlotId()).toBe(a.id);
    });

    it('refuses to activate an unknown slot rather than blanking the session', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});

        expect(await service.activate('no-such-slot')).toBe(false);
        expect(await service.activeSlotId()).toBe(a.id);
    });

    it('falls back to the most recently used survivor when the live slot is removed', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const b = await service.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});
        await service.activate(a.id);

        await service.remove(a.id);

        expect(await service.activeSlotId()).toBe(b.id);
    });

    it('leaves no slot live when the last one is removed', async () => {
        const only = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        await service.remove(only.id);

        expect(await service.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
        expect(await service.activeSlot()).toBeNull();
    });

    it('leaves the live slot alone when a different one is removed', async () => {
        const a = await service.ensureSlot({userId: 'user-1', serverUrl: 'https://a.example'});
        const b = await service.ensureSlot({userId: 'user-2', serverUrl: 'https://a.example'});

        await service.remove(a.id);

        expect(await service.activeSlotId()).toBe(b.id);
    });

    it('survives a restart - the file, not the in-memory signal, is the source of truth', async () => {
        const slot = await service.ensureSlot({
            userId: 'user-1', serverUrl: 'https://a.example', username: 'ada',
        });

        const restarted = freshService();

        expect(await restarted.activeSlotId()).toBe(slot.id);
        expect((await restarted.list())[0].username).toBe('ada');
    });

    it('reads a store that has never been written as empty rather than throwing', async () => {
        LazyStoreMock.files.set('settings.json', new Map([['accounts', {} as unknown]]));
        const bare = freshService();

        expect(await bare.list()).toEqual([]);
        expect(await bare.activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
    });
});
