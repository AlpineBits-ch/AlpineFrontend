/** The two things the notification page never said. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {signal} from '@angular/core';
import {describe, expect, it} from 'vitest';
import {NotificationSettingsComponent} from './notification-settings.component';
import {NotificationService} from '../../../../../services/notification.service';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../platform/host';
import {GuildService} from '../../../../../services/guild.service';
import {GuildDto} from '../../../../../dtos/response/guild.dto';

function guildFixture(id: string, name: string): GuildDto {
    return {id, name} as unknown as GuildDto;
}

function render(
    host: PlatformHost,
    blocked = false,
    guilds: GuildDto[] = [],
): ComponentFixture<NotificationSettingsComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            // Stubbed to the one signal this page reads. The real service asks the `Notifier` port for
            // permission on the first notification, and driving it that far to flip one boolean would
            // test the service rather than the page.
            {provide: NotificationService, useValue: {notificationsBlocked: signal(blocked)}},
            {provide: GuildService, useValue: {guilds: signal(guilds)}},
            provideFakePlatform({host}),
        ],
    });

    const fixture = TestBed.createComponent(NotificationSettingsComponent);
    fixture.detectChanges();
    return fixture;
}

function blockedLine(fixture: ComponentFixture<NotificationSettingsComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="notifications-blocked"]');
}

function foregroundLine(fixture: ComponentFixture<NotificationSettingsComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="notifications-foreground-only"]');
}

describe('NotificationSettingsComponent host limits', () => {
    it('says nothing extra on the desktop shell', () => {
        const fixture = render('tauri');

        expect(blockedLine(fixture)).toBeNull();
        expect(foregroundLine(fixture)).toBeNull();
    });

    it('says notifications only arrive while Venta is open, in a browser', () => {
        const fixture = render('web');

        expect(foregroundLine(fixture)?.textContent?.trim()).toBe('SETTINGS.NOTIFICATIONS.FOREGROUND_ONLY');
        // Not blocked, only foreground-only: the two are different facts and must not appear together
        // just because the host is a browser.
        expect(blockedLine(fixture)).toBeNull();
    });

    it('says so when the host has refused, so the switch cannot claim to work', () => {
        const fixture = render('web', true);

        expect(blockedLine(fixture)?.textContent?.trim()).toBe('SETTINGS.NOTIFICATIONS.BLOCKED');
    });

    it('reports a desktop refusal too, if one is ever latched there', () => {
        // The flag is only latched on hosts without native toasts today, but the page must not have
        // hard-coded that: it reads the service, not the host.
        expect(blockedLine(render('tauri', true))).not.toBeNull();
    });

    it('leaves the enable switch usable while blocked', () => {
        // Deliberate. It still gates the sound and the cooldown, both of which keep working while the
        // toast is blocked, so disabling it would remove two controls that work to describe one that
        // does not. What the page owes here is the sentence.
        const fixture = render('web', true);
        const first = fixture.nativeElement.querySelector('p-toggleswitch input') as HTMLInputElement;

        expect(first.disabled).toBe(false);
    });
});

describe('NotificationSettingsComponent go-live toggles', () => {
    it('renders nothing about streaming for an account in no guilds', () => {
        const fixture = render('tauri', false, []);

        expect(fixture.nativeElement.textContent).not.toContain('SETTINGS.NOTIFY_GO_LIVE');
    });

    it('lists a toggle for every guild, off by default', () => {
        const fixture = render('tauri', false, [guildFixture('g1', 'Alpha'), guildFixture('g2', 'Beta')]);

        const g1Row = fixture.nativeElement.querySelector('[data-testid="go-live-toggle-g1"]');
        const g2Row = fixture.nativeElement.querySelector('[data-testid="go-live-toggle-g2"]');
        expect(g1Row).not.toBeNull();
        expect(g2Row).not.toBeNull();

        const g1Switch = g1Row.querySelector('input') as HTMLInputElement;
        const g2Switch = g2Row.querySelector('input') as HTMLInputElement;
        expect(g1Switch.checked).toBe(false);
        expect(g2Switch.checked).toBe(false);
    });

    it('flips the toggle for the clicked guild only', () => {
        const fixture = render('tauri', false, [guildFixture('g1', 'Alpha'), guildFixture('g2', 'Beta')]);
        const g1Switch = fixture.nativeElement.querySelector(
            '[data-testid="go-live-toggle-g1"] input',
        ) as HTMLInputElement;

        g1Switch.click();
        fixture.detectChanges();

        const component = fixture.componentInstance as unknown as {
            isGoLiveEnabled(id: string): boolean;
        };
        expect(component.isGoLiveEnabled('g1')).toBe(true);
        expect(component.isGoLiveEnabled('g2')).toBe(false);
    });

    it('translates the section header rather than leaving it hardcoded', () => {
        const fixture = render('tauri', false, [guildFixture('g1', 'Alpha')]);

        expect(fixture.nativeElement.textContent).toContain('SETTINGS.STREAMING_SECTION');
    });

    it('defaults the friends toggle on, independent of the per-guild list', async () => {
        const fixture = render('tauri', false, [guildFixture('g1', 'Alpha')]);
        await fixture.whenStable();
        fixture.detectChanges();

        const friendsSwitch = fixture.nativeElement.querySelector(
            '[data-testid="go-live-friends-toggle"] input',
        ) as HTMLInputElement;
        const g1Switch = fixture.nativeElement.querySelector(
            '[data-testid="go-live-toggle-g1"] input',
        ) as HTMLInputElement;

        expect(friendsSwitch.checked).toBe(true);
        expect(g1Switch.checked).toBe(false);
    });

    it('flips the friends toggle without touching any guild toggle', () => {
        const fixture = render('tauri', false, [guildFixture('g1', 'Alpha')]);
        const friendsSwitch = fixture.nativeElement.querySelector(
            '[data-testid="go-live-friends-toggle"] input',
        ) as HTMLInputElement;

        friendsSwitch.click();
        fixture.detectChanges();

        const component = fixture.componentInstance as unknown as {
            isGoLiveEnabled(id: string): boolean;
            userSettings: {notificationSettings(): {goLiveFriendsEnabled: boolean}};
        };
        expect(component.userSettings.notificationSettings().goLiveFriendsEnabled).toBe(false);
        expect(component.isGoLiveEnabled('g1')).toBe(false);
    });
});
