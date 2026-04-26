import {Component, inject, input, signal} from '@angular/core';
import {ConversationDto} from "../../../../dtos/response/conversation.dto";
import {ComposerComponent} from "./composer/composer.component";
import {InputText} from "primeng/inputtext";
import {MessageComponent} from "./message/message.component";
import {MessageDto} from "../../../../dtos/response/message.dto";
import {ButtonDirective} from "primeng/button";
import {Avatar} from "primeng/avatar";
import {MessagingService} from "../../../../services/messaging.service";

@Component({
  selector: 'app-conversation',
  imports: [
    ComposerComponent,
    InputText,
    MessageComponent,
    ButtonDirective,
    Avatar
  ],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent {
  public conversation = input.required<ConversationDto>();
  public messages = signal<MessageDto[]>([])
  public messageService = inject(MessagingService);

  public createMessage(message: string){
    this.messageService.createMessage({
      content: message,
      contextId: this.conversation().id,
    }).subscribe();
  }
}
