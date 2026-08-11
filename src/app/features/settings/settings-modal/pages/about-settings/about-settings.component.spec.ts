/**
 * The updater block on the About page, on both hosts.
 *
 * <p>The design spec's own example of a control that is <b>hidden</b> rather than disabled with a
 * reason: a web client updates by being reloaded, so there is nothing a user came looking for. Before
 * this gate the button was live in a browser and produced no visible status at all - `UpdateService`
 * answers `'unsupported'`, which this template renders as neither "up to date" nor "check failed", so
 * pressing it looked like nothing had happened.</p>
 *
 * <p>Both directions are asserted. A test that only checked the browser would pass just as happily if
 * the block had been removed from the desktop app too.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {describe, expect, it} from 'vitest';
import {AboutSettingsComponent} from './about-settings.component';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../platform/host';

function render(host: PlatformHost): ComponentFixture<AboutSettingsComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideFakePlatform({host}),
        ],
    });

    const fixture = TestBed.createComponent(AboutSettingsComponent);
    fixture.detectChanges();
    return fixture;
}

function updateCheck(fixture: ComponentFixture<AboutSettingsComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="update-check"]');
}

describe('AboutSettingsComponent update check', () => {
    it('offers the check on the desktop shell', () => {
        const fixture = render('tauri');

        expect(updateCheck(fixture)).not.toBeNull();
        expect(fixture.nativeElement.textContent).toContain('Check for updates');
    });

    it('hides it in a browser rather than offering a button with no answer', () => {
        const fixture = render('web');

        expect(updateCheck(fixture)).toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain('Check for updates');
    });

    it('keeps the rest of the page, so the section is not what was hidden', () => {
        // Guards against the gate being written one `@if` too high: the licences block and the version
        // card have nothing to do with self-update and must survive on both hosts.
        expect(render('web').nativeElement.textContent).toContain('Third-party software');
        expect(render('tauri').nativeElement.textContent).toContain('Third-party software');
    });
});
