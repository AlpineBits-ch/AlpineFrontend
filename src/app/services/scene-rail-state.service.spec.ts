import {TestBed} from '@angular/core/testing';
import {beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {SCENE_RAIL_STORAGE_KEY, SceneRailStateService} from './scene-rail-state.service';

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

function service(): SceneRailStateService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(SceneRailStateService);
}

describe('SceneRailStateService', () => {
    beforeEach(() => localStorage.clear());

    it('starts with every shelf closed', () => {
        expect(service().expanded('g1')).toEqual([]);
    });

    it('opens and closes a shelf', () => {
        const state = service();

        state.toggle('g1', 'f1');
        expect(state.isExpanded('g1', 'f1')).toBe(true);

        state.toggle('g1', 'f1');
        expect(state.isExpanded('g1', 'f1')).toBe(false);
    });

    it('keeps guilds apart', () => {
        const state = service();

        state.toggle('g1', 'f1');

        expect(state.expanded('g1')).toEqual(['f1']);
        expect(state.expanded('g2')).toEqual([]);
    });

    it('survives a restart', () => {
        service().toggle('g1', 'f1');

        expect(service().isExpanded('g1', 'f1')).toBe(true);
    });

    it('answers for a missing guild id without throwing', () => {
        const state = service();

        expect(state.expanded(null)).toEqual([]);
        expect(state.navOpen(undefined)).toBe(false);
    });

    it('starts the sidebar section closed', () => {
        expect(service().navOpen('g1')).toBe(false);
    });

    it('remembers an opened sidebar section across a restart', () => {
        service().setNavOpen('g1', true);

        expect(service().navOpen('g1')).toBe(true);
    });

    it('keeps the sidebar section per guild', () => {
        const state = service();

        state.setNavOpen('g1', true);

        expect(state.navOpen('g2')).toBe(false);
    });

    it('reads a corrupt blob as nothing remembered', () => {
        localStorage.setItem(SCENE_RAIL_STORAGE_KEY, '{not json');

        expect(service().expanded('g1')).toEqual([]);
    });

    it('starts with no remembered rail width', () => {
        expect(service().railWidth()).toBeNull();
    });

    it('round-trips a rail width', () => {
        service().setRailWidth(320);

        expect(service().railWidth()).toBe(320);
    });

    it('is not per guild: one width follows a person everywhere', () => {
        const state = service();

        state.setRailWidth(280);

        expect(state.railWidth()).toBe(280);
    });

    it('clears back to the default', () => {
        const state = service();
        state.setRailWidth(320);

        state.setRailWidth(null);

        expect(state.railWidth()).toBeNull();
    });

    it('reads a corrupt width as nothing remembered', () => {
        localStorage.setItem(SCENE_RAIL_STORAGE_KEY, JSON.stringify({width: 'wide'}));

        expect(service().railWidth()).toBeNull();
    });
});
