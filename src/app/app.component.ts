import {Component, DestroyRef, HostListener, inject, OnDestroy, OnInit} from "@angular/core";
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NavigationEnd, Router, RouterOutlet} from "@angular/router";
import {ProfileService} from "./services/profile.service";
import {AuthService} from "./services/auth.service";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
import {CallMiniPlayerComponent} from "./features/call/call-mini-player/call-mini-player.component";
import {TitlebarComponent} from "./titlebar/titlebar.component";
import {ResizeHandlesComponent} from "./titlebar/resize-handles.component";
import {CallWebRtcService} from "./services/call-webrtc.service";
import {CallHotkeyService} from "./services/call-hotkey.service";
import {UpdateDialogComponent} from "./features/update-dialog/update-dialog.component";
import {UpdateService} from "./services/update.service";
import {Toast} from "primeng/toast";
import {ScreenPickerComponent} from './features/screen-picker/screen-picker.component';
import {EmailVerificationDialogComponent} from './features/email-verification/email-verification-dialog.component';
import {MfaChallengeDialogComponent} from './features/mfa-challenge/mfa-challenge-dialog.component';
import {PasswordResetDialogComponent} from './features/password-reset/password-reset-dialog.component';
import {InviteDialogComponent} from './features/invite-dialog/invite-dialog.component';
import {InviteDialogService} from './features/invite-dialog/invite-dialog.service';
import {environment} from "../environments/environment";
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
    selector: "app-root",
    imports: [RouterOutlet, CallOverlayComponent, CallMiniPlayerComponent, TitlebarComponent, ResizeHandlesComponent, UpdateDialogComponent, Toast, ScreenPickerComponent, EmailVerificationDialogComponent, MfaChallengeDialogComponent, PasswordResetDialogComponent, InviteDialogComponent, IsleProximityBarComponent, BotInstallDialogComponent, BotCommandDialogComponent, BotModalDialogComponent, DiscordImportProgressDialogComponent, LegalConsentDialogComponent, StatusBannerComponent, VoiceRingCardComponent],
    templateUrl: "./app.component.html",
    styleUrl: "./app.component.css",
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
    // Injected for its side effect: it holds the effect that keeps the identity on crash reports
    // in step with the account's data-collection consent. Nothing reads it back.
    private telemetryConsent = inject(TelemetryConsentService);
    private platformStatus = inject(PlatformStatusService);
    // Also injected for its side effect: it subscribes to the ring events and does the
    // reconnect catch-up read. Constructing it here rather than leaving it to the card means a ring
    // that arrives before anything has rendered one is still caught.
    private voiceRings = inject(VoiceRingStateService);
    private updateInterval: ReturnType<typeof setInterval> | null = null;

    @HostListener('document:contextmenu', ['$event'])
    onContextMenu(event: MouseEvent) {
        if (environment.production) {
            event.preventDefault();
        }
    }

    // iOS: visual viewport scrolls when keyboard opens, making position:fixed elements
    // appear to shift. Track offsetTop/height and mirror them onto CSS variables so

    public  ngOnInit(): void {
        if (this.isPopup) return;

        // Window shape and the drag fallback for overlays. Started here rather than in the titlebar
        // because both outlive it: the radius belongs to app-root, and the drag fallback exists
        // precisely for the moments the titlebar is covered.
        void this.windowChrome.start();

        // Started here rather than on the main page: the answer to "is it me or is it them" is
        // most wanted on the login screen, which is where an identity outage strands people.
        this.platformStatus.start();

        void this.deepLinks.onOpen((urls) => {
            for (const url of urls) this.handleDeepLink(url);
        });
        // Cold start: the OS may have launched the app fresh via a deep link, in which case the live
        // listener above misses it entirely - initial() is that launch URL. It answers at most once
        // per process, and the guard that makes that true now lives in the Tauri adapter, where it
        // belongs: "the same URL keeps coming back until the process exits" is a property of the
        // plugin, not of this component. On web it is always null, because the address bar is the
        // launch URL and the router has already handled it.
        void this.deepLinks.initial().then(url => {
            if (url) this.handleDeepLink(url);
        });

        // Resumes an install-bot modal that was stashed because the user was logged out when
        // the deep link arrived (see BotInstallDialogService.requestOpen).
        this.router.events.pipe(
            filter(e => e instanceof NavigationEnd),
            filter(() => this.router.url.startsWith('/overview')),
            takeUntilDestroyed(this.destroyRef),
        ).subscribe(() => {
            this.botInstallDialogService.resumeIfPending();
            this.discordImportProgressService.resumeIfPending();
        });

        window.visualViewport?.addEventListener('resize', this.viewportHandler);
        window.visualViewport?.addEventListener('scroll', this.viewportHandler);
        this.viewportHandler();

        // Warms ProfileService.ownProfile(), which a dozen components read synchronously to answer
        // "is this me" - and which MainPageComponent only fills in on the launch path where
        // `resolveAccountGates` runs to completion, so it can legitimately still be unset.
        //
        // Gated on the session because on the login route it is a guaranteed 401 on every single
        // launch. Signed out there is no refresh token, so `isLoggedIn` answers false without
        // reaching the network at all; signed in it shares the guard's in-flight refresh rather
        // than starting a second one.
        void this.authService.isLoggedIn().then(signedIn => {
            if (!signedIn) return;
            this.profileService.getSelf().subscribe({
                error: err => console.error('Could not preload own profile', err),
            });
        });

        // No check on launch: update_gate.rs already ran one before this window
        // existed. Only the periodic check remains, for a release that ships
        // while the app is open.
        this.updateInterval = setInterval(() => {
            void this.updateService.checkForUpdates();
        }, 10 * 60 * 1000);

        // Keeps the splash up until routing has settled - which now includes answering whether
        // there is a session at all - and takes it down anywhere but /overview, where
        // MainPageComponent owns the moment. Safety net included. See revealWhenRouted().
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

    // Mouse back/forward (buttons 3/4) otherwise trigger WebView history navigation,
    // which is jarring in an app shell -and interferes with binding them to push-to-talk.
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
