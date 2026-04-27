import { Component } from '@angular/core';

@Component({
  selector: 'app-privacy-settings',
  imports: [],
  templateUrl: './privacy-settings.component.html',
  styleUrl: './privacy-settings.component.css',
})
export class PrivacySettingsComponent {
  public readonly friendRequestOptions = [
    { label: 'Everyone',       desc: 'Anyone on Alpine can send you a request.', active: true  },
    { label: 'Friends of Friends', desc: 'Only people who share a mutual friend.', active: false },
    { label: 'Nobody',         desc: 'Disable all incoming friend requests.',      active: false },
  ];

  public readonly dmToggles = [
    { label: 'Allow DMs from friends',        desc: 'Friends can send you direct messages.' },
    { label: 'Allow DMs from server members', desc: 'People in shared servers can message you.' },
  ];

  public readonly presenceToggles = [
    { label: 'Show online status',   desc: 'Let others see when you are active.' },
    { label: 'Show current activity', desc: 'Display what you are playing or working on.' },
  ];
}
