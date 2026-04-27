import {Component, output, signal} from '@angular/core';
import {ServerData, ServerIconComponent} from "../server-icon/server-icon.component";

@Component({
  selector: 'app-server-taskbar',
  imports: [
    ServerIconComponent
  ],
  templateUrl: './server-taskbar.component.html',
  styleUrl: './server-taskbar.component.css',
})
export class ServerTaskbarComponent {
  public menuToggle = output();

  public servers = signal<ServerData[]>([
    { id: '1', name: 'UX Design',   icon: '', isHome: false, badge: 3, isActive: true },
    { id: '2', name: 'Gaming Hub',  icon: '', isHome: false, isActive: false },
    { id: '3', name: 'Creators',    icon: '', isHome: false, isActive: false },
  ]);
}
