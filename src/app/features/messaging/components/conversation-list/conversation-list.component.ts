import { animate, query, stagger, style, transition, trigger } from '@angular/animations';
import { Component, computed, effect, inject, output, signal } from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';
import {
  IonList, IonItem, IonItemSliding, IonItemOptions, IonItemOption,
  IonLabel, IonBadge, IonIcon, IonInfiniteScroll, IonInfiniteScrollContent,
} from '@ionic/angular/standalone';
import { InfiniteScrollCustomEvent } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { trashOutline } from 'ionicons/icons';

import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { MessageDto } from '../../../../dtos/response/message.dto';

import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { UserStatusDotComponent } from '../../../../components/user-status-dot/user-status-dot.component';
import { TypingDotsComponent } from '../../../../components/typing-dots/typing-dots.component';

import { ProfileService } from '../../../../services/profile.service';
import { MessagingService } from '../../../../services/messaging.service';
import { ConversationService } from '../../../../services/conversation.service';
import { MessagingWebsocketService } from '../../../../services/messaging-websocket.service';
import { ConversationUtilsService } from '../../../../services/conversation-utils.service';

import { ConversationStore } from '../../../../stores/conversation.store';
import { MessageStore } from '../../../../stores/message.store';

import { ToastService } from '../../../../services/toast.service';
import { NavigationService } from '../../../main-page/navigation.service';

const PREVIEW_SIZE = 30;
import {PlatformService} from "../../../../services/platform.service";

@Component({
  selector: 'app-conversation-list',
  imports: [
    AppAvatarComponent, DatePipe, NgClass, UserStatusDotComponent, TypingDotsComponent,
    IonList, IonItem, IonItemSliding, IonItemOptions, IonItemOption,
    IonLabel, IonBadge, IonIcon, IonInfiniteScroll, IonInfiniteScrollContent,
  ],
  templateUrl: './conversation-list.component.html',
  styleUrl: './conversation-list.component.css',
  animations: [
    trigger('convList', [
      transition(':increment, :decrement, * => *', [
        query(':enter', [
          style({ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }),
          stagger(40, [
            animate('220ms cubic-bezier(0.4, 0, 0.2, 1)',
              style({ opacity: 1, transform: 'translateY(0) scale(1)' })
            ),
          ]),
        ], { optional: true }),
        query(':leave', [
          animate('160ms ease-in',
            style({ opacity: 0, transform: 'translateX(8px)' })
          ),
        ], { optional: true }),
      ]),
    ]),
  ],
})
export class ConversationListComponent {
  public conversationSelected = output<ConversationDto>();

  protected conversationStore = inject(ConversationStore);
  protected convUtils         = inject(ConversationUtilsService);

  private navService          = inject(NavigationService);
  private profileService      = inject(ProfileService);
  private messagingService    = inject(MessagingService);
  private conversationService = inject(ConversationService);
  private messageStore        = inject(MessageStore);
  private toast               = inject(ToastService);
  private messagingWs         = inject(MessagingWebsocketService);

  public platformService = inject(PlatformService)

  readonly selectedId = computed(() => {
    const view = this.navService.mainView();
    return view.type === 'conversation' ? view.conversation.id : null;
  });

  readonly sortedConversations = computed(() =>
    [...this.conversationStore.entities()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  );

  readonly sortKey = computed(() => this.sortedConversations().map(c => c.id).join(','));

  // Per-conversation preview: last PREVIEW_SIZE messages, newest first.
  // Used for the last-message preview text, timestamp, and unread count.
  // Intentionally separate from MessageStore to avoid the list recomputing
  // whenever the open conversation loads its full message history.
  previewMessages = signal<Map<string, MessageDto[]>>(new Map());

  // Unread count per conversation.
  // Only depends on previewMessages + conversationStore (for lastReadMessageId).
  // Does NOT read from MessageStore — that was the source of the UI freeze.
  readonly unreadCounts = computed(() => {
    const ownId  = this.profileService.ownProfile()?.userId;
    const prevMap = this.previewMessages();
    const result  = new Map<string, number>();

    for (const conv of this.conversationStore.entities()) {
      const ownMember  = conv.members.find(m => m.userId === ownId);
      const lastReadId = ownMember?.lastReadMessageId;
      // msgs are newest-first; index 0 is the most recent message.
      const msgs = prevMap.get(conv.id) ?? [];

      if (!lastReadId) {
        result.set(conv.id, msgs.length);
      } else {
        const readIdx = msgs.map(m => m.id).indexOf(lastReadId);
        // readIdx === -1: lastRead is older than all previewed messages → all PREVIEW_SIZE unread.
        // readIdx ===  0: newest message is already read → 0 unread.
        // readIdx ===  N: N messages newer than the last-read position.
        result.set(conv.id, readIdx === -1 ? msgs.length : readIdx);
      }
    }

    return result;
  });

  constructor() {
    addIcons({ trashOutline });
    this.conversationStore.loadInitial();

    // Prepend new messages to the preview window (keeps newest-first order).
    const prependPreview = (msg: MessageDto) => {
      if (!msg.conversationId) return;
      this.previewMessages.update(map => {
        const existing = map.get(msg.conversationId!) ?? [];
        const updated  = [msg, ...existing].slice(0, PREVIEW_SIZE);
        return new Map(map).set(msg.conversationId!, updated);
      });
    };
    this.messagingWs.messageObservable.subscribe(prependPreview);
    this.messagingService.messageSentObservable.subscribe(prependPreview);

    // Fetch the initial preview for any conversation not yet loaded.
    effect(() => {
      const convs  = this.conversationStore.entities();
      const loaded = this.previewMessages();
      convs
        .filter(c => !loaded.has(c.id))
        .forEach(c => {
          this.messagingService.getMessagesForConversation(c.id, 0, PREVIEW_SIZE).subscribe(msgs => {
            // API returns messages ascending (oldest-first); reverse so index 0 is always the newest,
            // consistent with the websocket prepend behaviour.
            this.previewMessages.update(map => new Map(map).set(c.id, [...msgs].reverse()));
          });
        });
    });
  }

  public getPreview(conv: ConversationDto): { sender: string; text: string } | null {
    const msg = this.previewMessages().get(conv.id)?.[0]; // [0] is newest
    if (!msg) return null;

    const ownId  = this.profileService.ownProfile()?.userId;
    const sender = msg.authorId === ownId
      ? 'You'
      : (conv.members.find(m => m.userId === msg.authorId)?.cachedUserName ?? 'Unknown');

    let text: string;
    try {
      const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch {
      text = msg.content;
    }
    text = text.replace(/@([\w\-.]+)#\w+/g, '@$1');

    return { sender, text };
  }

  public getUnreadCount(convId: string): number {
    return this.unreadCounts().get(convId) ?? 0;
  }

  public onIonInfinite(event: InfiniteScrollCustomEvent): void {
    this.conversationStore.loadMore();
    setTimeout(() => event.target.complete(), 400);
  }

  public deleteConversation(conv: ConversationDto, event?: MouseEvent): void {
    event?.stopPropagation();
    const name = this.convUtils.getChatTitle(conv);
    this.conversationService.deleteConversation(conv.id).subscribe({
      next: () => {
        this.conversationStore.removeConversation(conv.id);
        this.messageStore.removeMessagesForConversation(conv.id);
        if (this.selectedId() === conv.id) {
          this.navService.showHome();
        }
        this.toast.success('Conversation deleted', { detail: name });
      },
      error: (err) => this.toast.httpError('Failed to delete conversation', err),
    });
  }
}
