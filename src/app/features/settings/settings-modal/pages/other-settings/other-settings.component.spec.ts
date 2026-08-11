/**
 * The launch-on-startup switch, on both hosts.
 *
 * <p><b>Disabled with a reason rather than hidden</b>, unlike the updater on the About page. "Start
 * Venta when I sign in" is a setting people go looking for, and a row that has simply vanished reads
 * as a missing feature rather than as one this host cannot offer.</p>
 *
 * <p>The bug this closes: `UserSettingsService` already declines to call the port when autostart is
 * unsupported, so in a browser the switch moved, saved a preference, and nothing ever acted on it.
 * That is precisely the "control left enabled over a no-op" the design spec forbids.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {describe, expect, it} from 'vitest';
import {OtherSettingsComponent} from './other-settings.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../platform/host';

function render(host: PlatformHost): ComponentFixture<OtherSettingsComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            provideFakePlatform({host}),
        ],
    });

    const fixture = TestBed.createComponent(OtherSettingsComponent);
    fixture.detectChanges();
    return fixture;
}

/** The autostart switch is the first toggle in the System section, and the third on the page. */
function autostartSwitch(fixture: ComponentFixture<OtherSettingsComponent>): HTMLInputElement {
    const inputs = fixture.nativeElement.querySelectorAll('p-toggleswitch input');
    // Two interest toggles come first; the System section opens with autostart.
    return inputs[2] as HTMLInputElement;
}

function reason(fixture: ComponentFixture<OtherSettingsComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="autostart-unsupported"]');
}

describe('OtherSettingsComponent autostart', () => {
    it('is live and unexplained on the desktop shell', () => {
        const fixture = render('tauri');

        expect(autostartSwitch(fixture).disabled).toBe(false);
        expect(reason(fixture)).toBeNull();
    });

    it('is disabled with a stated reason in a browser', () => {
        const fixture = render('web');

        expect(autostartSwitch(fixture).disabled).toBe(true);
        expect(reason(fixture)?.textContent?.trim()).toBe('SETTINGS.OTHER.AUTOSTART_UNSUPPORTED');
    });

    it('keeps the row on screen, so the reason has something to be about', () => {
        // Hidden would be the wrong call here and this is what says so: the label survives.
        expect(render('web').nativeElement.textContent).toContain('SETTINGS.OTHER.AUTOSTART');
    });
});
