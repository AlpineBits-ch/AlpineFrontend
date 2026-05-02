import { Component } from '@angular/core';
import { Button } from 'primeng/button';
import { DatePipe } from '@angular/common';

interface MockBan {
  id: string;
  userName: string;
  reason: string;
  bannedAt: Date;
}

@Component({
  selector: 'app-bans-settings',
  imports: [Button, DatePipe],
  templateUrl: './bans-settings.component.html',
})
export class BansSettingsComponent {
  protected readonly bans: MockBan[] = [
    {
      id: '1',
      userName: 'trollmaster99',
      reason: 'Repeated harassment and targeting of other members',
      bannedAt: new Date('2024-08-12'),
    },
    {
      id: '2',
      userName: 'spam_bot_001',
      reason: 'Automated spam messages and phishing links',
      bannedAt: new Date('2024-09-03'),
    },
    {
      id: '3',
      userName: 'rude_dude42',
      reason: 'Hate speech and sustained toxic behavior',
      bannedAt: new Date('2024-10-17'),
    },
  ];

  protected avatarLabel(userName: string): string {
    return userName.charAt(0).toUpperCase();
  }
}
