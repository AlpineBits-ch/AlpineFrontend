import {Component, inject, model} from '@angular/core';
import {Button} from "primeng/button";
import {ProfileService} from "../../../../services/profile.service";
import {Avatar} from "primeng/avatar";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";
import {FriendshipModalComponent} from "../../../friendship/components/friendship-modal/friendship-modal.component";

@Component({
  selector: 'app-quick-settings',
  imports: [
    Button,
    Avatar,
    ConnectionStatusComponent,
    FriendshipModalComponent
  ],
  templateUrl: './quick-settings.component.html',
  styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
  protected profileService = inject(ProfileService);

  public isFriendshipModalVisible = model(false);
  constructor() {
    if (!this.profileService.profile()){
      this.profileService.getSelf().subscribe();
    }
  }
}
