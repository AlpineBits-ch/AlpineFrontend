/**
 * What the keybinds page says about a host that has no global hotkeys.
 *
 * <p>The single most user-visible difference in the browser port, so it is stated at the top of the page
 * rather than left to be discovered. The bindings do still capture and still fire - the web adapter
 * listens for `keydown` - but only while the tab is focused, and push-to-talk exists precisely for the
 * case where it is not: a game is in front.</p>
 *
 * <p>Two things are asserted beyond the notice appearing. That the notice names the substitute, because
 * "your keys do not work" without "voice activity keys the mic instead" leaves the user with no way to
 * be heard at all. And that the footnote's claim - Isle keys "keep working while the game is focused" -
 * is not made in a browser, where it is simply false; it used to be printed on every host.</p>
 */
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
        providers: [
            provideTranslateService(),
            provideFakePlatform({host}),
        ],
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

        expect(fixture.nativeElement.textContent)
            .not.toContain('keep working while the game is focused');
        // The rest of the footnote is host-independent and must survive.
        expect(fixture.nativeElement.querySelector('[data-testid="keybinds-footnote-web"]')?.textContent)
            .toContain('Voice Call keys are keyboard-only');
    });

    it('still offers every binding, because a focused key is not a dead one', () => {
        // Nothing here is disabled: the page is useful in a browser for everything that is not
        // proximity voice, and the honest answer for that part is the substitute, not a dead row.
        expect(render('web').nativeElement.querySelectorAll('button').length)
            .toBe(render('tauri').nativeElement.querySelectorAll('button').length);
    });
});
