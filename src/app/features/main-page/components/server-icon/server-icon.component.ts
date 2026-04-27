import {Component, input} from '@angular/core';

export interface ServerData {
  id: string;
  name: string;
  icon?: string;
  isHome: boolean;
  badge?: number;
  isActive?: boolean;
}
@Component({
  selector: 'app-server-icon',
  imports: [],
  templateUrl: './server-icon.component.html',
  styleUrl: './server-icon.component.css',
})
export class ServerIconComponent {
  public serverData = input.required<ServerData>();
}
