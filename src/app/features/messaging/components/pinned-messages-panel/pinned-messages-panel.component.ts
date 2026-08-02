import {Component, DestroyRef, effect, inject, input, output, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessagingService} from '../../../../services/messaging.service';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {ToastService} from '../../../../services/toast.service';
import {MessageStore} from '../../../../stores/message.store';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../helpers/message-content.helper';

@Component({
    selector: 'app-pinned-messages-panel',
    imports: [DatePipe],
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
    private toastService = inject(ToastService);
    private messageStore = inject(MessageStore);
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
        // The stored copy first, because it is the one the read paths have already judged - the
        // pinned list is fetched separately and its `undecryptable` has never been evaluated.
        const stored = this.messageStore.entityMap()[msg.id];
        return readableContent(stored ?? msg, UNDECRYPTABLE_SHORT).slice(0, 120);
    }
}
