import {TestBed} from '@angular/core/testing';
import {WikiNavPrefsService} from './wiki-nav-prefs.service';

/** This runner's `localStorage` global has no methods, so every write would silently no-op and every read would answer "nothing stored". Same Map-backed stand-in `wiki-drafts.service.spec.ts` uses. */
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

describe('WikiNavPrefsService', () => {
    let service: WikiNavPrefsService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        service = TestBed.inject(WikiNavPrefsService);
    });

    it('starts empty', () => {
        service.load('g1');
        expect(service.favourites()).toEqual([]);
        expect(service.recents()).toEqual([]);
        expect(service.collapsed()).toEqual([]);
    });

    it('toggles a favourite on and off', () => {
        service.load('g1');
        service.toggleFavourite('p1');
        expect(service.isFavourite('p1')).toBe(true);
        service.toggleFavourite('p1');
        expect(service.isFavourite('p1')).toBe(false);
    });

    it('restores favourites written by a previous session', () => {
        service.load('g1');
        service.toggleFavourite('p1');

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        const reloaded = TestBed.inject(WikiNavPrefsService);
        reloaded.load('g1');
        expect(reloaded.isFavourite('p1')).toBe(true);
    });

    // A favourite in one server surfacing in another's tree would be a leak of what you read.
    it('keeps guilds apart', () => {
        service.load('g1');
        service.toggleFavourite('p1');

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({});
        const other = TestBed.inject(WikiNavPrefsService);
        other.load('g2');
        expect(other.isFavourite('p1')).toBe(false);
    });

    it('puts the most recent visit first without duplicating it', () => {
        service.load('g1');
        service.recordVisit('a');
        service.recordVisit('b');
        service.recordVisit('a');
        expect(service.recents()).toEqual(['a', 'b']);
    });

    it('caps the recent list', () => {
        service.load('g1');
        for (let i = 0; i < 20; i++) service.recordVisit(`p${i}`);
        expect(service.recents()).toHaveLength(8);
        expect(service.recents()[0]).toBe('p19');
    });

    // The nav records from the selected-page signal, which re-fires for reasons unrelated to navigation; a re-record of the page already at the front must not reorder anything.
    it('is a no-op when the same page is recorded twice in a row', () => {
        service.load('g1');
        service.recordVisit('a');
        service.recordVisit('b');
        service.recordVisit('b');
        expect(service.recents()).toEqual(['b', 'a']);
    });

    it('remembers collapsed categories', () => {
        service.load('g1');
        service.toggleCollapsed('c1');
        expect(service.isCollapsed('c1')).toBe(true);
        service.toggleCollapsed('c1');
        expect(service.isCollapsed('c1')).toBe(false);
    });

    it('forgets a deleted id everywhere', () => {
        service.load('g1');
        service.toggleFavourite('p1');
        service.recordVisit('p1');
        service.toggleCollapsed('p1');
        service.forget('p1');
        expect(service.isFavourite('p1')).toBe(false);
        expect(service.recents()).toEqual([]);
        expect(service.isCollapsed('p1')).toBe(false);
    });

    it('clears recents', () => {
        service.load('g1');
        service.recordVisit('a');
        service.clearRecents();
        expect(service.recents()).toEqual([]);
    });

    // A second load for the same guild happens on every effect run; re-reading storage there would throw away anything not yet written.
    it('ignores a repeated load of the same guild', () => {
        service.load('g1');
        service.toggleFavourite('p1');
        service.load('g1');
        expect(service.isFavourite('p1')).toBe(true);
    });

    it('survives a corrupt entry', () => {
        localStorage.setItem('wiki-nav:favourites:g1', '{not json');
        service.load('g1');
        expect(service.favourites()).toEqual([]);
    });

    it('ignores a stored value that is not a list of strings', () => {
        localStorage.setItem('wiki-nav:recents:g1', '{"a":1}');
        service.load('g1');
        expect(service.recents()).toEqual([]);
    });
});
