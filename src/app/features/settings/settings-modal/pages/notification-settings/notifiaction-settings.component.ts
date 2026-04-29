import { Component, inject } from '@angular/core';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { UserSettingsService } from '../../../../../services/user-settings.service';

@Component({
  selector: 'app-notification-settings',
  imports: [ToggleSwitch, FormsModule],
  templateUrl: './notifiaction-settings.component.html',
  styleUrl: './notifiaction-settings.component.css',
})
export class NotifiactionSettingsComponent {
  protected readonly userSettings = inject(UserSettingsService);
}
