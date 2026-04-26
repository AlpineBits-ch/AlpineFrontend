import { Component } from '@angular/core';
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

  public defaultServer: ServerData = {
    id: '1',
    name: 'Default Server',
    icon: 'https://primefaces.org/cdn/primeng/images/primeng.svg',
    isHome: true
  };
}
