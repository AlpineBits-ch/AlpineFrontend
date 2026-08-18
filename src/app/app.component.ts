import {
    afterNextRender,
    Component,
    DestroyRef,
    ElementRef,
    HostListener,
    inject,
    OnDestroy,
    OnInit,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NavigationEnd, Router, RouterOutlet} from '@angular/router';
import {ProfileService} from './services/profile.service';
import {AuthService} from './services/auth.service';
import {CallOverlayComponent} from './features/call/call-overlay/call-overlay.component';
import {CallMiniPlayerComponent} from './features/call/call-mini-player/call-mini-player.component';
import {TitlebarComponent} from './titlebar/titlebar.component';
import {ResizeHandlesComponent} from './titlebar/resize-handles.component';
import {CallWebRtcService} from './services/call-webrtc.service';
import {CallHotkeyService} from './services/call-hotkey.service';
import {UpdateDialogComponent} from './features/update-dialog/update-dialog.component';
import {UpdateService} from './services/update.service';
import {Toast} from 'primeng/toast';
import {ScreenPickerComponent} from './features/screen-picker/screen-picker.component';
import {EmailVerificationDialogComponent} from './features/email-verification/email-verification-dialog.component';
import {MfaChallengeDialogComponent} from './features/mfa-challenge/mfa-challenge-dialog.component';
import {PasswordResetDialogComponent} from './features/password-reset/password-reset-dialog.component';
import {InviteDialogComponent} from './features/invite-dialog/invite-dialog.component';
import {InviteDialogService} from './features/invite-dialog/invite-dialog.service';
import {environment} from '../environments/environment';
import {AppReadyService} from './services/app-ready.service';
import {WindowChromeService} from './services/window-chrome.service';
import {filter} from 'rxjs';
import {DeepLinks} from './platform/ports/deep-links.port';
import {SteamService} from './services/steam.service';
import {IsleProximityBarComponent} from './features/isle-proximity/isle-proximity-bar.component';
import {BotInstallDialogComponent} from './features/bot-install/bot-install-dialog.component';
import {BotCommandDialogComponent} from './features/bot-command/bot-command-dialog.component';
import {BotModalDialogComponent} from './features/bot-modal/bot-modal-dialog.component';
import {BotInstallDialogService} from './features/bot-install/bot-install-dialog.service';
import {parseInstallBotLink} from './features/bot-install/bot-install-link.util';
import {DiscordImportProgressDialogComponent} from './features/discord-import/discord-import-progress-dialog.component';
import {DiscordImportProgressService} from './features/discord-import/discord-import-progress.service';
import {parseDiscordImportLink} from './features/discord-import/discord-import-link.util';
import {TelemetryConsentService} from './services/telemetry-consent.service';
import {LegalConsentDialogComponent} from './components/legal-consent-dialog/legal-consent-dialog.component';
import {StatusBannerComponent} from './components/status-banner/status-banner.component';
import {PlatformStatusService} from './services/platform-status.service';
import {VoiceRingCardComponent} from './shared/call/voice-ring-card/voice-ring-card.component';
import {VoiceRingStateService} from './services/voice-ring-state.service';

@Component({
    selector: 'app-root',
    imports: [
        RouterOutlet,
        CallOverlayComponent,
        CallMiniPlayerComponent,
        TitlebarComponent,
        ResizeHandlesComponent,
        UpdateDialogComponent,
        Toast,
        ScreenPickerComponent,
        EmailVerificationDialogComponent,
        MfaChallengeDialogComponent,
        PasswordResetDialogComponent,
        InviteDialogComponent,
        IsleProximityBarComponent,
        BotInstallDialogComponent,
        BotCommandDialogComponent,
        BotModalDialogComponent,
        DiscordImportProgressDialogComponent,
        LegalConsentDialogComponent,
        StatusBannerComponent,
        VoiceRingCardComponent,
    ],
    templateUrl: './app.component.html',
    styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
    protected readonly isPopup = window.location.pathname === '/toast-popup';
    private profileService = inject(ProfileService);
    private authService = inject(AuthService);
    private callWebRtc = inject(CallWebRtcService);
    private callHotkey = inject(CallHotkeyService);
    private updateService = inject(UpdateService);
    private router = inject(Router);
    private appReady = inject(AppReadyService);
    private inviteDialogService = inject(InviteDialogService);
    private steamService = inject(SteamService);
    private botInstallDialogService = inject(BotInstallDialogService);
    private discordImportProgressService = inject(DiscordImportProgressService);
    private destroyRef = inject(DestroyRef);
    private windowChrome = inject(WindowChromeService);
    private deepLinks = inject(DeepLinks);
    // Do not remove: injected for its side effect, keeping crash-report identity in step with consent.
    private telemetryConsent = inject(TelemetryConsentService);
    private platformStatus = inject(PlatformStatusService);
    // Do not remove: constructed here so a ring arriving before the card renders is still caught.
    private voiceRings = inject(VoiceRingStateService);
    private updateInterval: ReturnType<typeof setInterval> | null = null;
    private host = inject(ElementRef<HTMLElement>);

    constructor() {
        // app-root is `position: fixed` and therefore its own stacking context, and every dialog in
        // the app appends its mask to the body. No z-index on the toast can beat that from in here,
        // so the element moves out to sit beside the masks.
        afterNextRender(() => {
            const toast = this.host.nativeElement.querySelector('p-toast');
            if (toast) document.body.appendChild(toast);
        });
    }

    @HostListener('document:contextmenu', ['$event'])
    onContextMenu(event: MouseEvent) {
        if (environment.production) {
            event.preventDefault();
        }
    }

    // iOS: the visual viewport scrolls when the keyboard opens, shifting position:fixed elements.

    public ngOnInit(): void {
        if (this.isPopup) return;

        // Window shape and the drag fallback for overlays; both outlive the titlebar.
        void this.windowChrome.start();

        // Started here rather than on the main page, so it also covers the login screen.
        this.platformStatus.start();

        void this.deepLinks.onOpen(urls => {
            for (const url of urls) this.handleDeepLink(url);
        });
        // Cold start: the launch URL, which the live listener above misses entirely. Null on web.
        void this.deepLinks.initial().then(url => {
            if (url) this.handleDeepLink(url);
        });

        // Resumes an install-bot modal that was stashed because the user was logged out when
        // the deep link arrived (see BotInstallDialogService.requestOpen).
        this.router.events
            .pipe(
                filter(e => e instanceof NavigationEnd),
                filter(() => this.router.url.startsWith('/overview')),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe(() => {
                this.botInstallDialogService.resumeIfPending();
                this.discordImportProgressService.resumeIfPending();
            });

        window.visualViewport?.addEventListener('resize', this.viewportHandler);
        window.visualViewport?.addEventListener('scroll', this.viewportHandler);
        this.viewportHandler();

        // Warms ProfileService.ownProfile(), gated on the session so the login route does not 401.
        void this.authService.isLoggedIn().then(signedIn => {
            if (!signedIn) return;
            this.profileService.getSelf().subscribe({
                error: err => console.error('Could not preload own profile', err),
            });
        });

        // No check on launch: update_gate.rs already ran one before this window existed.
        this.updateInterval = setInterval(
            () => {
                void this.updateService.checkForUpdates();
            },
            10 * 60 * 1000,
        );

        // Keeps the splash up until routing settles, except on /overview where MainPageComponent owns it.
        this.appReady.revealWhenRouted();
    }

    private handleDeepLink(url: string): void {
        const inviteMatch = url.match(/invite\/([^/?#]+)/);
        if (inviteMatch) {
            this.inviteDialogService.open(inviteMatch[1]);
            return;
        }

        if (url.includes('steam-auth')) {
            this.steamService.handleLinkCallback(this.parseSteamStatus(url));
            return;
        }

        if (url.includes('discord-import')) {
            const params = parseDiscordImportLink(url);
            if (params) void this.discordImportProgressService.requestOpen(params);
            return;
        }

        if (url.includes('install-bot')) {
            const params = parseInstallBotLink(url);
            if (params) void this.botInstallDialogService.requestOpen(params);
            return;
        }
    }

    /** Reads the `status` query param from a `venta://steam-auth?status=...` deep link. */
    private parseSteamStatus(url: string): string {
        const match = url.match(/[?&]status=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : 'error';
    }

    @HostListener('document:keydown', ['$event'])
    onKeydown(event: KeyboardEvent): void {
        if (this.isPopup) return;
        if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'u') {
            this.updateService.openDebugDialog();
        }
    }

    // Mouse back/forward (buttons 3/4) otherwise trigger WebView history navigation and break push-to-talk.
    @HostListener('document:mousedown', ['$event'])
    @HostListener('document:auxclick', ['$event'])
    onAuxMouse(event: MouseEvent): void {
        if (event.button === 3 || event.button === 4) event.preventDefault();
    }

    public ngOnDestroy(): void {
        window.visualViewport?.removeEventListener('resize', this.viewportHandler);
        window.visualViewport?.removeEventListener('scroll', this.viewportHandler);
        if (this.updateInterval !== null) {
            clearInterval(this.updateInterval);
        }
    }

    // app-root always occupies exactly the visible area.
    private readonly viewportHandler = (): void => {
        const vv = window.visualViewport;
        if (!vv) return;
        document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop}px`);
        document.documentElement.style.setProperty('--vv-height', `${vv.height}px`);
    };
}
