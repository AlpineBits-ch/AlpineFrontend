import {inject, Injectable, signal} from '@angular/core';
import {GuildWebsocketService, WsBotModalOpen} from '../../services/guild-websocket.service';

/** Holds the modal a bot has asked this client to show. */
@Injectable({providedIn: 'root'})
export class BotModalDialogService {
    readonly request = signal<WsBotModalOpen | null>(null);

    private guildWs = inject(GuildWebsocketService);

    constructor() {
        // Last one wins. A bot can only have one modal on screen at a time, and queueing them
        // would leave a stale form standing over an interaction the user has moved on from.
        this.guildWs.modalOpenObservable.subscribe(request => this.request.set(request));
    }

    close(): void {
        this.request.set(null);
    }
}
