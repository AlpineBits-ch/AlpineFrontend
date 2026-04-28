import { Component } from '@angular/core';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { Select } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';

@Component({
  selector: 'app-other-settings',
  imports: [ToggleSwitch, Select, FormsModule, Button],
  templateUrl: './other-settings.component.html',
  styleUrl: './other-settings.component.css',
})
export class OtherSettingsComponent {
  selectedLanguage = 'en-us';

  public readonly languages = [
    { label: 'English (US)', value: 'en-us' },
  ];

  public readonly systemToggles = [
    { label: 'Launch on startup',    desc: 'Start Alpine automatically when your device boots.' },
    { label: 'Minimize to tray',     desc: 'Keep Alpine running in the system tray when closed.' },
    { label: 'Run in background',    desc: 'Continue receiving notifications when minimized.' },
  ];

  public readonly advancedToggles = [
    { label: 'Hardware acceleration', desc: 'Use GPU rendering for smoother performance.' },
    { label: 'Developer mode',        desc: 'Show additional debug information and tools.' },
  ];
}
