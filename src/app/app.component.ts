import {Component, inject} from "@angular/core";
import { RouterOutlet } from "@angular/router";
import {ProfileService} from "./services/profile.service";
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import {environment} from "../environments/environment";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {TitlebarComponent} from "./titlebar/titlebar.component";
import {ToastContainerComponent} from "./toast/toast-container/toast-container.component";
import {CallWebRtcService} from "./services/call-webrtc.service";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, CallOverlayComponent, TitlebarComponent, ToastContainerComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  private profileService = inject(ProfileService);
  // Eagerly instantiate CallWebRtcService so its session-watch effect starts immediately
  private callWebRtc = inject(CallWebRtcService);
  protected readonly isPopup = window.location.pathname === '/toast-popup';

  public ngOnInit(): void {
    if (this.isPopup) return;

    if ('__TAURI_INTERNALS__' in window) {
      void getCurrentWindow().maximize();
    }
    this.profileService.getSelf().subscribe((profile) => {
      console.log('Profile:', profile);
    });
    void updateApp();
    async function updateApp() {
      if(!environment.production) return;
      try {
        const update = await check();

        if (update) {
          console.log(`Update found: ${update.version}`);

          await update.downloadAndInstall();

          // Restart the app
          await relaunch();
        }else {
          console.log('No update available');
        }
      } catch (error) {
        console.error('Error checking for updates:', error);
      }

    }
  }
}
