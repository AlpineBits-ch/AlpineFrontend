/**
 * Exporting a theme, which is the one thing `ThemeService` needed a host for.
 *
 * <p>It used to open a Tauri save dialog and write the file itself, so in a browser it did nothing at
 * all. Behind {@link FileSaver} the same call reaches the download manager instead. The suggested
 * filename is asserted because it is load-bearing beyond cosmetics: the desktop adapter derives the save
 * dialog's file-type filter from the extension in it.</p>
 */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {FileSaver} from '../platform/ports/file-saver.port';
import {FakeFileSaver} from '../platform/testing/fake-file-saver';
import {AppTheme} from '../models/theme.model';
import {ThemeService} from './theme.service';

/**
 * This runner's `localStorage` global has no methods, so `ThemeService` would see every read answer
 * undefined and throw while loading its themes. Same Map-backed stand-in `wiki-drafts.service.spec.ts`
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

function setup() {
    localStorage.clear();
    const saver = new FakeFileSaver();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            {provide: FileSaver, useValue: saver},
        ],
    });
    return {service: TestBed.inject(ThemeService), saver};
}

afterEach(() => localStorage.clear());

describe('ThemeService.exportTheme', () => {
    it('hands the theme to the host as JSON under a slugified name', async () => {
        const {service, saver} = setup();
        const builtIn = service.themes()[0];

        await service.exportTheme(builtIn.id);

        expect(saver.onlyCall.name).toBe('alpine-dark.json');
        expect(saver.onlyCall.mime).toBe('application/json');
        const parsed = JSON.parse(saver.onlyCallAsText()) as AppTheme;
        expect(parsed.name).toBe(builtIn.name);
        expect(parsed.colors).toEqual(builtIn.colors);
    });

    /** The `.json` is what the desktop dialog turns into its file-type filter. */
    it('keeps a name with spaces usable as a filename', async () => {
        const {service, saver} = setup();
        service.createTheme('My Warm  Theme');

        await service.exportTheme(service.activeThemeId());

        expect(saver.calls[0].name).toBe('my-warm-theme.json');
    });

    /** A round trip through the exported JSON has to reproduce the theme, or the file is decorative. */
    it('writes something importTheme accepts', async () => {
        const {service, saver} = setup();
        service.createTheme('Round Trip');
        await service.exportTheme(service.activeThemeId());

        service.importTheme(saver.calls[0].data as string);

        const imported = service.activeTheme();
        expect(imported.name).toBe('Round Trip');
        // A fresh id, so importing a theme next to the one it came from cannot collide.
        expect(service.themes().filter(t => t.name === 'Round Trip')).toHaveLength(2);
    });

    it('asks the host for nothing when the theme does not exist', async () => {
        const {service, saver} = setup();

        await service.exportTheme('no-such-theme');

        expect(saver.calls).toEqual([]);
    });

    /**
     * Resolves either way. A dismissed dialog was always silent here, and on web there is nothing to
     * report - {@link FileSaver} cannot observe what the download manager did next.
     */
    it('resolves whether or not anything was written', async () => {
        const {service, saver} = setup();
        saver.cancelled = true;

        await expect(service.exportTheme(service.themes()[0].id)).resolves.toBeUndefined();
    });
});
