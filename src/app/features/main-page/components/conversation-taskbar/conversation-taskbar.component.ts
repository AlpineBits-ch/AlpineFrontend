import { Component } from '@angular/core';
import {ServerData, ServerIconComponent} from "../server-icon/server-icon.component";

@Component({
  selector: 'app-conversation-taskbar',
  imports: [
    ServerIconComponent
  ],
  templateUrl: './conversation-taskbar.component.html',
  styleUrl: './conversation-taskbar.component.css',
})
export class ConversationTaskbarComponent {

  public defaultServer: ServerData = {
    id: '1',
    name: 'Default Server',
    icon: 'https://primefaces.org/cdn/primeng/images/primeng.svg',
    isHome: true
  };
}
