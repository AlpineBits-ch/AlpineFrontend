import {TestBed} from '@angular/core/testing';
import {WikiDraft, WikiDraftsService} from './wiki-drafts.service';

/**
 * This runner's `localStorage` global has no methods, so drafts would silently no-op and every
 * read would answer "no draft". Same Map-backed stand-in `account-registry.service.spec.ts` uses.
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

function draft(over: Partial<WikiDraft> = {}): WikiDraft {
    return {
        title: 'Setup',
        content: 'hello',
        tags: [],
        isPinned: false,
        baseUpdatedAt: null,
        savedAt: 1000,
        ...over,
    };
}

describe('WikiDraftsService', () => {
    let service: WikiDraftsService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({});
        service = TestBed.inject(WikiDraftsService);
    });

    it('returns null when no draft was stored', () => {
        expect(service.read('g1', 'p1')).toBeNull();
    });

    it('round-trips a stored draft', () => {
        service.write('g1', 'p1', draft({content: 'edited'}));
        expect(service.read('g1', 'p1')?.content).toBe('edited');
    });

    it('keeps drafts for different pages apart', () => {
        service.write('g1', 'p1', draft({content: 'one'}));
        service.write('g1', 'p2', draft({content: 'two'}));
        expect(service.read('g1', 'p1')?.content).toBe('one');
        expect(service.read('g1', 'p2')?.content).toBe('two');
    });

    // Two guilds can each have an unsaved new page at once; a shared 'new' key would
    // silently serve one guild's draft to the other.
    it('keeps the new-page draft of different guilds apart', () => {
        service.write('g1', null, draft({title: 'From guild one'}));
        service.write('g2', null, draft({title: 'From guild two'}));
        expect(service.read('g1', null)?.title).toBe('From guild one');
        expect(service.read('g2', null)?.title).toBe('From guild two');
    });

    it('clears a draft', () => {
        service.write('g1', 'p1', draft());
        service.clear('g1', 'p1');
        expect(service.read('g1', 'p1')).toBeNull();
    });

    it('returns null and does not throw when the stored value is corrupt', () => {
        localStorage.setItem('wiki-draft:g1:p1', '{not json');
        expect(service.read('g1', 'p1')).toBeNull();
    });

    it('reports divergence when content differs from the server copy', () => {
        expect(service.divergesFrom(draft({content: 'edited'}), 'Setup', 'hello')).toBe(true);
    });

    it('reports divergence when only the title differs', () => {
        expect(service.divergesFrom(draft({title: 'Renamed'}), 'Setup', 'hello')).toBe(true);
    });

    // A draft written and then saved leaves an identical copy behind. Offering to "restore"
    // it would prompt on every visit for no reason.
    it('reports no divergence when the draft matches the server copy', () => {
        expect(service.divergesFrom(draft(), 'Setup', 'hello')).toBe(false);
    });
});
