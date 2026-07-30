import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';

import {OAuthService} from 'angular-oauth2-oidc';

import {ComposerComponent} from './composer.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {NotificationService} from '../../../../../services/notification.service';

describe('ComposerComponent', () => {
    let component: ComposerComponent;
    let fixture: ComponentFixture<ComposerComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
                // Reached transitively: the composer injects BotCommandService and
                // GuildWebsocketService, whose chain ends at AuthService -> OAuthService.
                // The composer never calls it, so a bare stub is enough.
                {provide: OAuthService, useValue: {getAccessToken: () => null, refreshToken: vi.fn(), logOut: vi.fn()}},
                // Real NotificationService calls Tauri APIs (platform(), focus sync via
                // UserSettingsService) from its constructor, which reject under jsdom.
                {provide: NotificationService, useValue: {createNotification: vi.fn()}},
            ],
        })
            .compileComponents();

        fixture = TestBed.createComponent(ComposerComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });
});
