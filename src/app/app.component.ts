import {Component, inject} from "@angular/core";
import { RouterOutlet } from "@angular/router";
import {ProfileService} from "./services/profile.service";
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
@Component({
  selector: "app-root",
    imports: [RouterOutlet],
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
      const update = await check();

      if (update) {
        console.log(`Update found: ${update.version}`);

        await update.downloadAndInstall();

        // Restart the app
        await relaunch();
      }else {
        console.log('No update available');
      }
    }
  }
}
