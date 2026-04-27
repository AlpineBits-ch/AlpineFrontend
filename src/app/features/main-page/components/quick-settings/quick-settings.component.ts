import {Component, inject, signal} from '@angular/core';
import {ProfileService} from "../../../../services/profile.service";
import {Avatar} from "primeng/avatar";
import {SettingsModalComponent} from "../../../../features/settings/settings-modal/settings-modal.component";

@Component({
  selector: 'app-quick-settings',
  imports: [
    Avatar,
    SettingsModalComponent,
  ],
  templateUrl: './quick-settings.component.html',
  styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
  protected profileService = inject(ProfileService);
  public isSettingsOpen = signal(false);

  constructor() {
    if (!this.profileService.profile()) {
      this.profileService.getSelf().subscribe();
    }
  }
}
