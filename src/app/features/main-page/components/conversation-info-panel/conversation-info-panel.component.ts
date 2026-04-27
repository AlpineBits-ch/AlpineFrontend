import { Component, computed, inject, input } from '@angular/core';
import { Avatar } from 'primeng/avatar';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { ProfileService } from '../../../../services/profile.service';

@Component({
  selector: 'app-conversation-info-panel',
  imports: [Avatar],
  templateUrl: './conversation-info-panel.component.html',
  styleUrl: './conversation-info-panel.component.css',
})
export class ConversationInfoPanelComponent {
  conversation = input.required<ConversationDto>();

  private profileService = inject(ProfileService);

  protected others = computed(() => {
    const ownId = this.profileService.ownProfile()?.userId;
    return this.conversation().members.filter(m => m.userId !== ownId);
  });

  protected isDirect = computed(() => this.others().length === 1);
}
