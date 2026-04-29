import {Component, inject} from '@angular/core';
import { NgClass } from '@angular/common';
import {ConnectionState, WebsocketService} from "../../../../services/websocket.service";

@Component({
  selector: 'app-connection-status',
  imports: [NgClass],
  templateUrl: './connection-status.component.html',
  styleUrl: './connection-status.component.css',
})
export class ConnectionStatusComponent {
  public websocketService = inject(WebsocketService);


  protected readonly ConnectionState = ConnectionState;
}
