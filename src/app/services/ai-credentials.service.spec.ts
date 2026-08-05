// Hoisted above every import by vitest, so it must be the first statement in the file - an
// import before it makes the ordering read backwards and warns.
vi.mock('tauri-plugin-secure-storage-api', () => ({
    secureStorage: {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn()},
}));

import {TestBed} from '@angular/core/testing';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {AiCredentialsService} from './ai-credentials.service';

/** Stateful stand-in for the keychain, so a set is observable by the next get. */
const keychain = new Map<string, string>();

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
        keychain.clear();
        localStore.clear();
        vi.mocked(secureStorage.getItem).mockImplementation(
            async (k: string) => keychain.get(k) ?? '',
        );
        vi.mocked(secureStorage.setItem).mockImplementation(async (k: string, v: string) => {
            keychain.set(k, v);
        });
        vi.mocked(secureStorage.removeItem).mockImplementation(async (k: string) => {
            keychain.delete(k);
        });

        TestBed.configureTestingModule({});
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
        vi.mocked(secureStorage.getItem).mockRejectedValue(new Error('locked'));
        expect(await service.getKey('openai')).toBeNull();
    });

    it('treats an empty stored value as no key', async () => {
        keychain.set('wiki-ai-key-openai', '');
        expect(await service.getKey('openai')).toBeNull();
    });

    it('refresh discovers exactly the providers that hold a key', async () => {
        keychain.set('wiki-ai-key-anthropic', 'a');
        keychain.set('wiki-ai-key-gemini', 'g');
        await service.refresh();
        expect([...service.configured()].sort()).toEqual(['anthropic', 'gemini']);
    });

    it('clearing does not fail when the slot was never written', async () => {
        vi.mocked(secureStorage.removeItem).mockRejectedValue(new Error('no such key'));
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
