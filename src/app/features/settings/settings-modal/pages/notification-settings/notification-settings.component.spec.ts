/**
 * The two things the notification page never said.
 *
 * <p><b>`notificationsBlocked` had no reader at all.</b> `NotificationService` latches it when a host
 * without native toasts refuses permission, and in a browser that refusal is durable - only the user,
 * in browser settings, can undo it. So "Enable Notifications" could sit there switched on, look
 * entirely correct, and deliver nothing.</p>
 *
 * <p><b>`backgroundPush` is not `nativeToasts`.</b> A tab shows toasts perfectly well; what it cannot do
 * is receive one while closed. The distinction is load-bearing - rendering it as "no notifications here"
 * is wrong in the direction that loses messages the user believes they will be told about - so the two
 * lines are asserted separately and the foreground-only line is asserted <i>absent</i> on desktop.</p>
 */
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

function render(host: PlatformHost, blocked = false): ComponentFixture<NotificationSettingsComponent> {
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

        expect(foregroundLine(fixture)?.textContent?.trim())
            .toBe('SETTINGS.NOTIFICATIONS.FOREGROUND_ONLY');
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
