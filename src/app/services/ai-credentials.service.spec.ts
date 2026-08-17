import {TestBed} from '@angular/core/testing';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeSecureStore} from '../platform/testing/fake-secure-store';
import {AiCredentialsService} from './ai-credentials.service';

/**
 * The keychain as a provided port, rather than `vi.mock('tauri-plugin-secure-storage-api')`.
 *
 * <p>The service depends on {@link SecureStore}, which is the OS keychain on desktop and IndexedDB in
 * a browser - so a fake adapter is the only stand-in that covers both hosts. Its failure switches are
 * what the module mock was really being used for: a keychain that is locked, and a backend that
 * throws on removing a slot it never held.</p>
 */
let secure: FakeSecureStore;

/** This runner's `localStorage` global has no methods - same stand-in the draft specs install. */
const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

describe('AiCredentialsService', () => {
    let service: AiCredentialsService;

    beforeEach(() => {
        localStore.clear();
        secure = new FakeSecureStore();

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [{provide: SecureStore, useValue: secure}],
        });
        service = TestBed.inject(AiCredentialsService);
    });

    it('round-trips a stored key', async () => {
        await service.setKey('anthropic', 'sk-ant-123');
        expect(await service.getKey('anthropic')).toBe('sk-ant-123');
    });

    it('keeps each provider in its own slot', async () => {
        await service.setKey('anthropic', 'a');
        await service.setKey('openai', 'o');
        expect(await service.getKey('anthropic')).toBe('a');
        expect(await service.getKey('gemini')).toBeNull();
    });

    it('marks a provider configured on set and unconfigured on clear', async () => {
        await service.setKey('gemini', 'g');
        expect(service.configured().has('gemini')).toBe(true);
        await service.clearKey('gemini');
        expect(service.configured().has('gemini')).toBe(false);
        expect(await service.getKey('gemini')).toBeNull();
    });

    // A locked keychain must read as "not configured" rather than throwing into the draft flow,
    // where the failure would surface as an unhandled rejection mid-generation.
    it('reports no key when the keychain throws', async () => {
        secure.getError = new Error('locked');
        expect(await service.getKey('openai')).toBeNull();
    });

    it('treats an empty stored value as no key', async () => {
        secure.put('wiki-ai-key-openai', '');
        expect(await service.getKey('openai')).toBeNull();
    });

    it('refresh discovers exactly the providers that hold a key', async () => {
        secure.put('wiki-ai-key-anthropic', 'a');
        secure.put('wiki-ai-key-gemini', 'g');
        await service.refresh();
        expect([...service.configured()].sort()).toEqual(['anthropic', 'gemini']);
    });

    it('clearing does not fail when the slot was never written', async () => {
        secure.removeError = new Error('no such key');
        await expect(service.clearKey('openai')).resolves.toBeUndefined();
    });

    it('persists the provider and model choice, which are not secrets', () => {
        service.selectProvider('openai', 'gpt-5');
        expect(service.selectedProvider()).toBe('openai');
        expect(service.selectedModel('fallback')).toBe('gpt-5');
    });

    it('rejects a garbage stored provider rather than trusting it', () => {
        localStore.set('wiki-ai-provider', 'skynet');
        expect(service.selectedProvider()).toBeNull();
    });

    it('falls back to the given model when nothing is stored', () => {
        expect(service.selectedModel('claude-opus-5')).toBe('claude-opus-5');
    });
});
