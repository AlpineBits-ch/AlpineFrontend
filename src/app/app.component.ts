import {Component, HostListener, inject, OnDestroy, OnInit} from "@angular/core";
import { RouterOutlet } from "@angular/router";
import {ProfileService} from "./services/profile.service";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
import {TitlebarComponent} from "./titlebar/titlebar.component";
import {CallWebRtcService} from "./services/call-webrtc.service";
import {UpdateDialogComponent} from "./features/update-dialog/update-dialog.component";
import {UpdateService} from "./services/update.service";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, CallOverlayComponent, TitlebarComponent, UpdateDialogComponent],
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

  public ngOnInit(): void {
    if (this.isPopup) return;


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
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
    }
  }
}
