import {inject, Injectable, signal} from '@angular/core';
import {GuildWebsocketService, WsBotModalOpen} from '../../services/guild-websocket.service';

/**
 * Holds the modal a bot has asked this client to show.
 *
 * <p>Same shape as {@link import('../bot-command/bot-command-dialog.service').BotCommandDialogService}
 * - a root singleton with one signal, and a host component mounted once in `app.component.html`
 * that renders whatever is in it. Bot-driven UI already worked that way for slash commands; this
 * is the push-driven half of it.</p>
 *
 * <p>The answer leaves over HTTP, not the socket: `guild.ModalOpen` carries the `customId` the bot
 * correlates on, and `POST /bots/guilds/{g}/channels/{c}/modal-submit` takes it back along with the
 * filled rows. There is no `guild.ModalSubmit` hub method and there does not need to be - see
 * {@link import('./bot-modal-dialog.component').BotModalDialogComponent}.</p>
 */
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
