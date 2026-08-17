/** What the keybinds page says about a host that has no global hotkeys. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeAll, describe, expect, it} from 'vitest';
import {KeybindsSettingsComponent} from './keybinds-settings.component';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../platform/host';

/**
 * This runner's global `localStorage` exists with no methods on it, and `KeybindsService` reads the
 * stored bindings from a field initialiser - so without this the injector dies before the component is
 * ever built.
 */
beforeAll(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
});

function render(host: PlatformHost): ComponentFixture<KeybindsSettingsComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [provideTranslateService(), provideFakePlatform({host})],
    });

    const fixture = TestBed.createComponent(KeybindsSettingsComponent);
    fixture.detectChanges();
    return fixture;
}

function notice(fixture: ComponentFixture<KeybindsSettingsComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="hotkeys-focus-only"]');
}

describe('KeybindsSettingsComponent global hotkeys', () => {
    it('says nothing on the desktop shell, where a bound key reaches us either way', () => {
        const fixture = render('tauri');

        expect(notice(fixture)).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('keep working while the game is focused');
    });

    it('warns that keys only fire while the tab is focused, and names the substitute', () => {
        const fixture = render('web');
        const text = notice(fixture)?.textContent ?? '';

        expect(text).toContain('SETTINGS.KEYBINDS.FOCUS_ONLY');
        // The half that matters most: without it the page says what is broken and not what to do.
        expect(text).toContain('SETTINGS.KEYBINDS.PTT_USE_VOICE_ACTIVITY');
    });

    it('drops the footnote claim that keys survive the game taking focus', () => {
        const fixture = render('web');

        expect(fixture.nativeElement.textContent).not.toContain('keep working while the game is focused');
        // The rest of the footnote is host-independent and must survive.
        expect(
            fixture.nativeElement.querySelector('[data-testid="keybinds-footnote-web"]')?.textContent,
        ).toContain('Voice Call keys are keyboard-only');
    });

    it('still offers every binding, because a focused key is not a dead one', () => {
        // Nothing here is disabled: the page is useful in a browser for everything that is not
        // proximity voice, and the honest answer for that part is the substitute, not a dead row.
        expect(render('web').nativeElement.querySelectorAll('button').length).toBe(
            render('tauri').nativeElement.querySelectorAll('button').length,
        );
    });
});
