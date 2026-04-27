import { Component, inject, output, signal } from '@angular/core';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { Avatar } from 'primeng/avatar';
import { ProfileService } from '../../../../services/profile.service';
import { ConversationStore } from '../../../../stores/conversation.store';

@Component({
  selector: 'app-conversation-list',
  imports: [Avatar],
  templateUrl: './conversation-list.component.html',
  styleUrl: './conversation-list.component.css',
})
export class ConversationListComponent {
  public conversationSelected = output<ConversationDto>();
  public selectedId = signal<string | null>(null);

  protected conversationStore = inject(ConversationStore);
  private profileService = inject(ProfileService);

  constructor() {
    this.conversationStore.loadInitial();
  }

  public getChatName(conversation: ConversationDto): string {
    const userProfile = this.profileService.ownProfile();
    if (!userProfile) return 'Loading...';

    const others = conversation.members.filter(m => m.userId !== userProfile.userId);
    if (others.length === 0) return 'Empty chat';
    if (others.length === 1) return `${others[0].cachedUserName}#${others[0].cachedUserHash}`;
    return conversation.name ?? 'Unnamed Chat';
  }
}
