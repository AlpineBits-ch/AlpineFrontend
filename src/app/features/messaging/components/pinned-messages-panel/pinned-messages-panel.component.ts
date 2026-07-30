import {Component, DestroyRef, effect, inject, input, output, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {Button} from 'primeng/button';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessagingService} from '../../../../services/messaging.service';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';

function decodeContent(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

@Component({
    selector: 'app-pinned-messages-panel',
    imports: [Button, DatePipe],
    templateUrl: './pinned-messages-panel.component.html',
})
export class PinnedMessagesPanelComponent {
    channelId = input<string>();
    conversationId = input<string>();
    messageSelected = output<string>();

    pins = signal<MessageDto[]>([]);
    loading = signal(true);

    private messagingService = inject(MessagingService);
    private messagingWs = inject(MessagingWebsocketService);
    private guildWs = inject(GuildWebsocketService);
    protected profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);

    constructor() {
        effect(() => {
            this.channelId();
            this.conversationId();
            this.load();
        });

        this.messagingWs.messagePinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.conversationId === this.conversationId()) this.load();
            });
        this.messagingWs.messageUnpinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.conversationId === this.conversationId()) this.load();
            });
        this.guildWs.messagePinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.channelId === this.channelId()) this.load();
            });
        this.guildWs.messageUnpinnedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.channelId === this.channelId()) this.load();
            });
    }

    load(): void {
        const channelId = this.channelId();
        const conversationId = this.conversationId();
        if (!channelId && !conversationId) return;
        this.loading.set(true);
        this.messagingService.getPinnedMessages({channelId, conversationId}).subscribe({
            next: pins => {
                this.pins.set(pins);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load pinned messages', err);
            },
        });
    }

    snippet(msg: MessageDto): string {
        return decodeContent(msg.content).slice(0, 120);
    }
}
