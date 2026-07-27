import {Injectable, signal} from '@angular/core';
import {BotCommandDto} from '../../dtos/response/bot-command.dto';

export interface PendingBotCommandRequest {
    guildId: string;
    channelId: string;
    command: BotCommandDto;
}

@Injectable({providedIn: 'root'})
export class BotCommandDialogService {
    readonly request = signal<PendingBotCommandRequest | null>(null);

    open(request: PendingBotCommandRequest): void {
        this.request.set(request);
    }

    close(): void {
        this.request.set(null);
    }
}
