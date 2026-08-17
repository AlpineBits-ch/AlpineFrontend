/** The Discord integration row, on both hosts. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OAuthService} from 'angular-oauth2-oidc';
import {describe, expect, it} from 'vitest';
import {ActivitySettingsComponent} from './activity-settings.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../platform/host';

function render(host: PlatformHost): ComponentFixture<ActivitySettingsComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            MessageService,
            // Stubbed rather than provided for real: the real one configures `OAuthService` and reads
            // the federated server out of `localStorage` from a field initialiser, and neither has
            // anything to do with which controls this page renders.
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // Reached through `UserSettingsService -> AuthService`. Nothing here authenticates.
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            provideFakePlatform({host}),
        ],
    });

    const fixture = TestBed.createComponent(ActivitySettingsComponent);
    fixture.detectChanges();
    return fixture;
}

/** The Discord row's switch is the last toggle on the page. */
function discordSwitch(fixture: ComponentFixture<ActivitySettingsComponent>): HTMLElement {
    const switches = fixture.nativeElement.querySelectorAll('p-toggleswitch');
    return switches[switches.length - 1] as HTMLElement;
}

function reason(fixture: ComponentFixture<ActivitySettingsComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="discord-unsupported"]');
}

describe('ActivitySettingsComponent Discord integration', () => {
    it('is enabled and unexplained on the desktop shell, where it works', () => {
        const fixture = render('tauri');

        expect(discordSwitch(fixture).querySelector('input')?.disabled).toBe(false);
        expect(reason(fixture)).toBeNull();
    });

    it('is disabled with a stated reason in a browser', () => {
        const fixture = render('web');

        expect(discordSwitch(fixture).querySelector('input')?.disabled).toBe(true);
        expect(reason(fixture)).not.toBeNull();
        // The key, not the sentence: the copy lives in the locales submodule and is not this spec's to
        // pin. What matters is that the row says something rather than sitting there dead.
        expect(reason(fixture)?.textContent?.trim())
            .toBe('SETTINGS.ACTIVITY.DISCORD_INTEGRATION_UNSUPPORTED');
    });

    it('still explains the per-game list in a browser', () => {
        // The pre-existing half of the same gate. Asserted here so a refactor that collapses the two
        // cannot quietly drop the older one.
        expect(render('web').nativeElement.textContent)
            .toContain('SETTINGS.ACTIVITY.GAMES_UNSUPPORTED');
    });
});
