import {Component, HostListener, inject, OnDestroy, OnInit} from "@angular/core";
import { NavigationEnd, Router, RouterOutlet } from "@angular/router";
import {ProfileService} from "./services/profile.service";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
import {TitlebarComponent} from "./titlebar/titlebar.component";
import {ResizeHandlesComponent} from "./titlebar/resize-handles.component";
import {CallWebRtcService} from "./services/call-webrtc.service";
import {UpdateDialogComponent} from "./features/update-dialog/update-dialog.component";
import {UpdateService} from "./services/update.service";
import {Toast} from "primeng/toast";
import { ScreenPickerComponent } from './features/screen-picker/screen-picker.component';
import { EmailVerificationDialogComponent } from './features/email-verification/email-verification-dialog.component';
import {environment} from "../environments/environment";
import { AppReadyService } from './services/app-ready.service';
import { filter, take } from 'rxjs';

@Component({
  selector: "app-root",
  imports: [RouterOutlet, CallOverlayComponent, TitlebarComponent, ResizeHandlesComponent, UpdateDialogComponent, Toast, ScreenPickerComponent, EmailVerificationDialogComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, OnDestroy {
  private profileService = inject(ProfileService);
  private callWebRtc = inject(CallWebRtcService);
  private updateService = inject(UpdateService);
  private router = inject(Router);
  private appReady = inject(AppReadyService);
  protected readonly isPopup = window.location.pathname === '/toast-popup';

  private updateInterval: ReturnType<typeof setInterval> | null = null;

  @HostListener('document:contextmenu', ['$event'])
  onContextMenu(event: MouseEvent) {
    if(environment.production){
      event.preventDefault();
    }
  }

  // iOS: visual viewport scrolls when keyboard opens, making position:fixed elements
  // appear to shift. Track offsetTop/height and mirror them onto CSS variables so
  // app-root always occupies exactly the visible area.
  private readonly viewportHandler = (): void => {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop}px`);
    document.documentElement.style.setProperty('--vv-height', `${vv.height}px`);
  };

  public ngOnInit(): void {
    if (this.isPopup) return;

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

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (this.isPopup) return;
    if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'u') {
      this.updateService.openDebugDialog();
    }
  }

  public ngOnDestroy(): void {
    window.visualViewport?.removeEventListener('resize', this.viewportHandler);
    window.visualViewport?.removeEventListener('scroll', this.viewportHandler);
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
    }
  }
}
