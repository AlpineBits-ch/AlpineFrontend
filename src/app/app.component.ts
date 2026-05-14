import {Component, HostListener, inject, OnDestroy, OnInit} from "@angular/core";
import { RouterOutlet } from "@angular/router";
import {ProfileService} from "./services/profile.service";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
import {TitlebarComponent} from "./titlebar/titlebar.component";
import {CallWebRtcService} from "./services/call-webrtc.service";
import {UpdateDialogComponent} from "./features/update-dialog/update-dialog.component";
import {UpdateService} from "./services/update.service";
import {Toast} from "primeng/toast";
import { ScreenPickerComponent } from './features/screen-picker/screen-picker.component';
import { EmailVerificationDialogComponent } from './features/email-verification/email-verification-dialog.component';

@Component({
  selector: "app-root",
  imports: [RouterOutlet, CallOverlayComponent, TitlebarComponent, UpdateDialogComponent, Toast, ScreenPickerComponent, EmailVerificationDialogComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, OnDestroy {
  private profileService = inject(ProfileService);
  // Eagerly instantiate CallWebRtcService so its session-watch effect starts immediately
  private callWebRtc = inject(CallWebRtcService);
  private updateService = inject(UpdateService);
  protected readonly isPopup = window.location.pathname === '/toast-popup';

  private updateInterval: ReturnType<typeof setInterval> | null = null;

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
