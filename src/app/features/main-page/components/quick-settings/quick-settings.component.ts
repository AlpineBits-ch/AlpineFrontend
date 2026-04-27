import {Component, inject, signal} from '@angular/core';
import {ProfileService} from "../../../../services/profile.service";
import {Avatar} from "primeng/avatar";
import {ConnectionState, WebsocketService} from "../../../../services/websocket.service";
import {ConnectionStatusComponent} from "../connection-status/connection-status.component";
import {SettingsModalComponent} from "../../../../features/settings/settings-modal/settings-modal.component";

@Component({
  selector: 'app-quick-settings',
  imports: [
    Avatar,
    ConnectionStatusComponent,
    SettingsModalComponent,
  ],
  templateUrl: './quick-settings.component.html',
  styleUrl: './quick-settings.component.css',
})
export class QuickSettingsComponent {
  protected profileService = inject(ProfileService);
  protected websocketService = inject(WebsocketService);
  protected readonly ConnectionState = ConnectionState;

  public isSettingsOpen = signal(false);

  constructor() {
    if (!this.profileService.profile()) {
      this.profileService.getSelf().subscribe();
    }
  }
}
