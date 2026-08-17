import {Component, inject} from '@angular/core';
import {NgClass} from '@angular/common';
import {ConnectionState, MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-connection-status',
    imports: [NgClass, TranslateModule],
    templateUrl: './connection-status.component.html',
    styleUrl: './connection-status.component.css',
})
export class ConnectionStatusComponent {
    public websocketService = inject(MessagingWebsocketService);

    protected readonly ConnectionState = ConnectionState;
}
