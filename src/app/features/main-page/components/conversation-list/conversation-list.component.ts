import {Component, effect, inject, signal, untracked} from '@angular/core';
import {ConversationService} from "../../../../services/conversation.service";
import {ConversationDto} from "../../../../dtos/response/conversation.dto";
import {InputText} from "primeng/inputtext";
import {Avatar} from "primeng/avatar";
import {ProfileService} from "../../../../services/profile.service";

@Component({
  selector: 'app-conversation-list',
  imports: [
    InputText,
    Avatar
  ],
  templateUrl: './conversation-list.component.html',
  styleUrl: './conversation-list.component.css',
})
export class ConversationListComponent {

  public offset = signal(0);
  public limit = signal(20);

  public conversationService = inject(ConversationService);
  public conversations = signal<ConversationDto[]>([])
  private profileService = inject(ProfileService);

  constructor() {
    effect(() => {
      const offset = this.offset();
      const limit = this.limit();

      const conversations = untracked(() => this.conversations());

      this.conversationService.getConversations(offset, limit).subscribe(d => {
        this.conversations.set(conversations.concat(d))
        const savedConversations = untracked(() => this.conversations());
        console.log(savedConversations);
      })

    });

  }
  public getChatName(conversation: ConversationDto): string {
    const userProfile = this.profileService.profile();
    if(!userProfile){
      return 'Loading...';
    }

    const members = conversation.members.filter(m => m.userId !== userProfile.userId);
    if(members.length === 0){
      return 'Empty chat';
    }
    if(members.length === 1){
      return `${members[0].cachedUserName}#${members[0].cachedUserHash}`;
    }
    return conversation.name ?? 'Unnamed Chat';
  }
}
