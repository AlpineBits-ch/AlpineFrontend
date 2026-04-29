import {Component, inject} from "@angular/core";
import { RouterOutlet } from "@angular/router";
import {ProfileService} from "./services/profile.service";
import {Toast} from "primeng/toast";
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import {environment} from "../environments/environment";
import {CallOverlayComponent} from "./features/call/call-overlay/call-overlay.component";
@Component({
  selector: "app-root",
    imports: [RouterOutlet, Toast, CallOverlayComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  private profileService = inject(ProfileService);
  public ngOnInit(): void {
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
