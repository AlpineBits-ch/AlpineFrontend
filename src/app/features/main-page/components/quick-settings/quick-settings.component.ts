import {Component, inject, signal} from '@angular/core';
import {ProfileService} from "../../../../services/profile.service";
import {Avatar} from "primeng/avatar";
import {Button} from "primeng/button";
import {ConnectionState, MessagingWebsocketService} from "../../../../services/messaging-websocket.service";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";
import {SettingsModalComponent} from "../../../../features/settings/settings-modal/settings-modal.component";

@Component({
  selector: 'app-quick-settings',
  imports: [
    Avatar,
    Button,
    ConnectionStatusComponent,
    SettingsModalComponent,
  ],
  templateUrl: './quick-settings.component.html',
  styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
  protected profileService = inject(ProfileService);
  protected websocketService = inject(MessagingWebsocketService);
  protected readonly ConnectionState = ConnectionState;

  public isSettingsOpen = signal(false);

  constructor() {
    if (!this.profileService.ownProfile()) {
      this.profileService.getSelf().subscribe();
    }
  }
}
