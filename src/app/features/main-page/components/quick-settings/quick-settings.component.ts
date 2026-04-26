import {Component, inject} from '@angular/core';
import {Button} from "primeng/button";
import {ProfileService} from "../../../../services/profile.service";
import {Avatar} from "primeng/avatar";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";

@Component({
  selector: 'app-quick-settings',
  imports: [
    Button,
    Avatar,
    ConnectionStatusComponent
  ],
  templateUrl: './quick-settings.component.html',
  styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
  protected profileService = inject(ProfileService);

  constructor() {
    if (!this.profileService.profile()){
      this.profileService.getSelf().subscribe();
    }
  }
}
