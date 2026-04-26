import {Component, input} from '@angular/core';
import {ConversationDto} from "../../../../dtos/response/conversation.dto";
import {ComposerComponent} from "./composer/composer.component";

@Component({
  selector: 'app-conversation',
  imports: [
    ComposerComponent
  ],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent {
  public conversation = input.required<ConversationDto>();
}
