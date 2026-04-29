import { Component, effect, inject, output, signal } from '@angular/core';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { MessageDto } from '../../../../dtos/response/message.dto';
import { Avatar } from 'primeng/avatar';
import { DatePipe, NgClass } from '@angular/common';
import { ProfileService } from '../../../../services/profile.service';
import { ConversationStore } from '../../../../stores/conversation.store';
import { MessagingService } from '../../../../services/messaging.service';

@Component({
  selector: 'app-conversation-list',
  imports: [Avatar, DatePipe, NgClass],
  templateUrl: './conversation-list.component.html',
  styleUrl: './conversation-list.component.css',
})
export class ConversationListComponent {
  public conversationSelected = output<ConversationDto>();
  public selectedId = signal<string | null>(null);

  protected conversationStore = inject(ConversationStore);
  private profileService = inject(ProfileService);
  private messagingService = inject(MessagingService);

  /** Last message per conversation id */
  lastMessages = signal<Map<string, MessageDto>>(new Map());

  /** Unread count per conversation id — ready to be wired to a backend endpoint */
  unreadCounts = signal<Map<string, number>>(new Map());

  constructor() {
    this.conversationStore.loadInitial();

    // Whenever the conversation list changes, fetch the last message for any new entries
    effect(() => {
      const convs = this.conversationStore.entities();
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

  public getChatName(conversation: ConversationDto): string {
    const userProfile = this.profileService.ownProfile();
    if (!userProfile) return 'Loading...';
    const others = conversation.members.filter(m => m.userId !== userProfile.userId);
    if (others.length === 0) return 'Empty chat';
    if (others.length === 1) return `${others[0].cachedUserName}#${others[0].cachedUserHash}`;
    return conversation.name ?? others.map(m => m.cachedUserName).join(', ');
  }

  public getPreview(conv: ConversationDto): { sender: string; text: string } | null {
    const msg = this.lastMessages().get(conv.id);
    if (!msg) return null;

    const ownId = this.profileService.ownProfile()?.userId;
    let sender: string;
    if (msg.authorId === ownId) {
      sender = 'You';
    } else {
      const member = conv.members.find(m => m.userId === msg.authorId);
      sender = member?.cachedUserName ?? 'Unknown';
    }

    let text: string;
    try {
      const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch {
      text = msg.content;
    }
    // Simplify mentions to just @Name
    text = text.replace(/@([\w\-.]+)#\w+/g, '@$1');

    return { sender, text };
  }

  public getUnreadCount(convId: string): number {
    return this.unreadCounts().get(convId) ?? 0;
  }

  /** Call this when a real-time message arrives to update the preview */
  public updateLastMessage(convId: string, msg: MessageDto): void {
    this.lastMessages.update(map => new Map(map).set(convId, msg));
  }
}
