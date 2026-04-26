import {Component, inject} from '@angular/core';
import {ConnectionState, WebsocketService} from "../../../../services/websocket.service";

@Component({
  selector: 'app-connection-status',
  imports: [],
  templateUrl: './connection-status.component.html',
  styleUrl: './connection-status.component.css',
})
export class ConnectionStatusComponent {
  public websocketService = inject(WebsocketService);


  protected readonly ConnectionState = ConnectionState;
}
