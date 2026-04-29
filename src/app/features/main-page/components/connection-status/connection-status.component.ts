import {Component, inject} from '@angular/core';
import { NgClass } from '@angular/common';
import {ConnectionState, MessagingWebsocketService} from "../../../../services/messaging-websocket.service";

@Component({
  selector: 'app-connection-status',
  imports: [NgClass],
  templateUrl: './connection-status.component.html',
  styleUrl: './connection-status.component.css',
})
export class ConnectionStatusComponent {
  public websocketService = inject(MessagingWebsocketService);


  protected readonly ConnectionState = ConnectionState;
}
