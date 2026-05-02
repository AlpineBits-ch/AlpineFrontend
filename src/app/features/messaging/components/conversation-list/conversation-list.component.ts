import { animate, query, stagger, style, transition, trigger } from '@angular/animations';
import { Component, computed, effect, inject, output, signal } from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';

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

@Component({
  selector: 'app-conversation-list',
  imports: [AppAvatarComponent, DatePipe, NgClass, UserStatusDotComponent, TypingDotsComponent],
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

  lastMessages = signal<Map<string, MessageDto>>(new Map());
  unreadCounts = signal<Map<string, number>>(new Map());

  constructor() {
    this.conversationStore.loadInitial();

    const updatePreview = (msg: MessageDto) => {
      if (msg.conversationId) {
        this.lastMessages.update(map => new Map(map).set(msg.conversationId!, msg));
      }
    };
    this.messagingWs.messageObservable.subscribe(updatePreview);
    this.messagingService.messageSentObservable.subscribe(updatePreview);

    effect(() => {
      const convs  = this.conversationStore.entities();
      const loaded = this.lastMessages();
      convs
        .filter(c => !loaded.has(c.id))
        .forEach(c => {
          this.messagingService.getMessagesForConversation(c.id, 0, 1).subscribe(msgs => {
            if (msgs.length > 0) {
              this.lastMessages.update(map => new Map(map).set(c.id, msgs[0]));
            }
          });
        });
    });
  }

  public getPreview(conv: ConversationDto): { sender: string; text: string } | null {
    const msg = this.lastMessages().get(conv.id);
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

  public deleteConversation(conv: ConversationDto, event: MouseEvent): void {
    event.stopPropagation();
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
      error: () => this.toast.error('Failed to delete conversation'),
    });
  }
}
