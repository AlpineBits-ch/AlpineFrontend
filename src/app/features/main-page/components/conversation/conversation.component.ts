import {Component, effect, inject, input, output, signal, untracked} from '@angular/core';
import {ConversationDto} from "../../../../dtos/response/conversation.dto";
import {ComposerComponent} from "./composer/composer.component";
import {MessageComponent} from "./message/message.component";
import {MessageDto} from "../../../../dtos/response/message.dto";
import {Avatar} from "primeng/avatar";
import {MessagingService} from "../../../../services/messaging.service";

@Component({
  selector: 'app-conversation',
  imports: [
    ComposerComponent,
    MessageComponent,
    Avatar
  ],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent {
  public conversation = input.required<ConversationDto>();
  public back = output();
  public messages = signal<MessageDto[]>([])
  public messageService = inject(MessagingService);


  constructor(messageService: MessagingService) {
    effect(() => {
      const conversation = this.conversation();

      if(!conversation){
        return;
      }
      messageService.getMessagesForConversation(this.conversation().id, 0, 10).subscribe(messages => {
        console.log(messages);
        this.messages.set(messages);
      });
    });

  }
  public createMessage(message: string){
    this.messageService.createMessage({
      content: message,
      contextId: this.conversation().id,
    }).subscribe();
  }
}
