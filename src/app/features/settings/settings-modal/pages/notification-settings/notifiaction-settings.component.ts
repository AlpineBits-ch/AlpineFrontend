import { Component } from '@angular/core';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-notification-settings',
  imports: [ToggleSwitch, FormsModule],
  templateUrl: './notifiaction-settings.component.html',
  styleUrl: './notifiaction-settings.component.css',
})
export class NotifiactionSettingsComponent {
  notificationsEnabled = true;
  dmNotifications = true;
  mentionNotifications = true;
  notificationSounds = true;
}
