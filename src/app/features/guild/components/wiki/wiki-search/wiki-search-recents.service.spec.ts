import {TestBed} from '@angular/core/testing';
import {WikiSearchRecentsService} from './wiki-search-recents.service';

/**
 * This runner's `localStorage` global has no methods, so every write would silently no-op and
 * every read would answer "nothing stored". Same Map-backed stand-in `wiki-drafts.service.spec.ts`
 * uses.
 */
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

describe('WikiSearchRecentsService', () => {
    let service: WikiSearchRecentsService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        service = TestBed.inject(WikiSearchRecentsService);
        service.load('g1');
    });

    it('starts empty', () => {
        expect(service.recent()).toEqual([]);
    });

    it('records the newest query first', () => {
        service.record('deploy');
        service.record('runbook');
        expect(service.recent()).toEqual(['runbook', 'deploy']);
    });

    it('ignores blank queries', () => {
        service.record('   ');
        expect(service.recent()).toEqual([]);
    });

    it('trims and de-duplicates regardless of case', () => {
        service.record('deploy');
        service.record('  Deploy  ');
        expect(service.recent()).toEqual(['Deploy']);
    });

    it('caps the list', () => {
        for (let i = 0; i < 12; i++) service.record(`q${i}`);
        expect(service.recent()).toHaveLength(6);
        expect(service.recent()[0]).toBe('q11');
    });

    it('removes one entry and clears them all', () => {
        service.record('a');
        service.record('b');
        service.remove('a');
        expect(service.recent()).toEqual(['b']);
        service.clear();
        expect(service.recent()).toEqual([]);
    });

    it('restores history written by a previous session', () => {
        service.record('deploy');

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        const reloaded = TestBed.inject(WikiSearchRecentsService);
        reloaded.load('g1');
        expect(reloaded.recent()).toEqual(['deploy']);
    });

    // What you searched for in one server is not the other server's business.
    it('keeps guilds apart', () => {
        service.record('deploy');

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        const other = TestBed.inject(WikiSearchRecentsService);
        other.load('g2');
        expect(other.recent()).toEqual([]);
    });

    it('survives a corrupt entry', () => {
        localStorage.setItem('wiki-search:recents:g2', 'not json');
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        const other = TestBed.inject(WikiSearchRecentsService);
        other.load('g2');
        expect(other.recent()).toEqual([]);
    });
});
