import { Component, inject } from '@angular/core';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { Select } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { UserSettingsService } from '../../../../../services/user-settings.service';

@Component({
  selector: 'app-other-settings',
  imports: [ToggleSwitch, Select, FormsModule, Button],
  templateUrl: './other-settings.component.html',
  styleUrl: './other-settings.component.css',
})
export class OtherSettingsComponent {
  protected readonly userSettings = inject(UserSettingsService);

  selectedLanguage = 'en-us';

  public readonly languages = [
    { label: 'English (US)', value: 'en-us' },
  ];

  public readonly systemToggles = [
    { label: 'Minimize to tray',     desc: 'Keep Alpine running in the system tray when closed.' },
    { label: 'Run in background',    desc: 'Continue receiving notifications when minimized.' },
  ];

  public readonly advancedToggles = [
    { label: 'Hardware acceleration', desc: 'Use GPU rendering for smoother performance.' },
    { label: 'Developer mode',        desc: 'Show additional debug information and tools.' },
  ];


  public async checkUpdates(){
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
