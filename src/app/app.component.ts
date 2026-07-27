import {Component, HostListener, inject, OnDestroy, OnInit} from "@angular/core";
import {NavigationEnd, Router, RouterOutlet} from "@angular/router";
import {ProfileService} from "./services/profile.service";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
import {TitlebarComponent} from "./titlebar/titlebar.component";
import {ResizeHandlesComponent} from "./titlebar/resize-handles.component";
import {CallWebRtcService} from "./services/call-webrtc.service";
import {CallHotkeyService} from "./services/call-hotkey.service";
import {UpdateDialogComponent} from "./features/update-dialog/update-dialog.component";
import {UpdateService} from "./services/update.service";
import {Toast} from "primeng/toast";
import {ScreenPickerComponent} from './features/screen-picker/screen-picker.component';
import {EmailVerificationDialogComponent} from './features/email-verification/email-verification-dialog.component';
import {InviteDialogComponent} from './features/invite-dialog/invite-dialog.component';
import {InviteDialogService} from './features/invite-dialog/invite-dialog.service';
import {environment} from "../environments/environment";
import {AppReadyService} from './services/app-ready.service';
import {filter, take} from 'rxjs';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import {SteamService} from './services/steam.service';
import {IsleProximityBarComponent} from './features/isle-proximity/isle-proximity-bar.component';

@Component({
    selector: "app-root",
    imports: [RouterOutlet, CallOverlayComponent, TitlebarComponent, ResizeHandlesComponent, UpdateDialogComponent, Toast, ScreenPickerComponent, EmailVerificationDialogComponent, InviteDialogComponent, IsleProximityBarComponent],
    templateUrl: "./app.component.html",
    styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, OnDestroy {
    protected readonly isPopup = window.location.pathname === '/toast-popup';
    private profileService = inject(ProfileService);
    private callWebRtc = inject(CallWebRtcService);
    private callHotkey = inject(CallHotkeyService);
    private updateService = inject(UpdateService);
    private router = inject(Router);
    private appReady = inject(AppReadyService);
    private inviteDialogService = inject(InviteDialogService);
    private steamService = inject(SteamService);
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

        void onOpenUrl((urls) => {
            for (const url of urls) {
                const match = url.match(/invite\/([^/?#]+)/);
                if (match) {
                    this.inviteDialogService.open(match[1]);
                    break;
                }

                if (url.includes('steam-auth')) {
                    const status = this.parseSteamStatus(url);
                    this.steamService.handleLinkCallback(status);
                    break;
                }
            }
        });

        window.visualViewport?.addEventListener('resize', this.viewportHandler);
        window.visualViewport?.addEventListener('scroll', this.viewportHandler);
        this.viewportHandler();

        this.profileService.getSelf().subscribe((profile) => {
            console.log('Profile:', profile);
        });

        void this.updateService.checkForUpdates();
        this.updateInterval = setInterval(() => {
            void this.updateService.checkForUpdates();
        }, 10 * 60 * 1000);

        // Fallback: hide loading screen when navigation lands on a non-main route
        // (e.g. /authentication). For /overview, MainPageComponent calls markReady().
        this.router.events.pipe(
            filter(e => e instanceof NavigationEnd),
            take(1),
        ).subscribe(() => {
            if (!this.router.url.startsWith('/overview')) {
                setTimeout(() => this.appReady.markReady(), 300);
            }
            // Absolute safety net: never leave the splash up indefinitely
            setTimeout(() => this.appReady.markReady(), 8000);
        });
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
