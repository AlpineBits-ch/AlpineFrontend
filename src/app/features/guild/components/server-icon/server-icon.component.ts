import {Component, input} from '@angular/core';
import { NgClass } from '@angular/common';

export interface ServerData {
  id: string;
  name: string;
  icon?: string;
  isHome: boolean;
  badge?: number;
  isActive?: boolean;
  hasUnread?: boolean;
}
@Component({
  selector: 'app-server-icon',
  imports: [NgClass],
  templateUrl: './server-icon.component.html',
  styleUrl: './server-icon.component.css',
})
export class ServerIconComponent {
  public serverData = input.required<ServerData>();
}
