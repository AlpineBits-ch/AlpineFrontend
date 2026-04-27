import { Component } from '@angular/core';

@Component({
  selector: 'app-other-settings',
  imports: [],
  templateUrl: './other-settings.component.html',
  styleUrl: './other-settings.component.css',
})
export class OtherSettingsComponent {
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
