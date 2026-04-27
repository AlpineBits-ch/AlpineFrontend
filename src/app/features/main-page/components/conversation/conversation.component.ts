import { Component, computed, effect, inject, input, output } from '@angular/core';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { ComposerComponent } from './composer/composer.component';
import { MessageComponent } from './message/message.component';
import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';
import { MessagingService } from '../../../../services/messaging.service';
import { MessageStore } from '../../../../stores/message.store';
import {tap} from "rxjs";

@Component({
  selector: 'app-conversation',
  imports: [ComposerComponent, MessageComponent, Avatar, Button],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent {
  public conversation = input.required<ConversationDto>();
  public back = output();

  private messageStore = inject(MessageStore);
  private messagingService = inject(MessagingService);

  protected messages = computed(() =>
    this.messageStore.entities().filter(m => m.conversationId === this.conversation().id)
  );

  constructor() {
    effect(() => {
      this.messageStore.loadForConversation(this.conversation().id);
    });
  }

  public createMessage(content: string): void {
    this.messagingService.createMessage({
      content,
      channelId: undefined,
      conversationId: this.conversation().id,
    }).pipe(tap(m => this.messageStore.addMessage(m))).subscribe();
  }
}
